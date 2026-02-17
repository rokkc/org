import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

# --- 0. CONFIGURATION ---
load_dotenv()

HINDSIGHT_URL = os.getenv("HINDSIGHT_API_URL", "http://127.0.0.1:8888")
BANK_ID = "personal-crm"
MODEL_NAME = os.getenv("LLM_MODEL", "gpt-4o")

# --- 1. GLOBAL STATE ---
http_client: Optional[httpx.AsyncClient] = None
openai_client: Optional[AsyncOpenAI] = None
sessions: Dict[str, List[dict]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, openai_client
    http_client = httpx.AsyncClient(timeout=60.0)
    openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    print(f"--- SYSTEM ONLINE: Async Hindsight Agent ({HINDSIGHT_URL}) ---")
    yield
    if http_client:
        await http_client.aclose()
    print("--- SYSTEM OFFLINE ---")


app = FastAPI(lifespan=lifespan)

# --- 2. MIDDLEWARE & STATIC FILES ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/js", StaticFiles(directory=os.path.join(BASE_DIR, "js")), name="js")
app.mount("/css", StaticFiles(directory=os.path.join(BASE_DIR, "css")), name="css")


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    reasoning_budget: str = "mid"
    use_reflect: bool = False
    persist_memory: bool = True


class DeepInsightsRequest(BaseModel):
    data: Dict[str, Any] = Field(default_factory=dict)
    max_items: int = 6
    reasoning_budget: str = "mid"
    use_reflect: bool = True


def stream_line(payload: dict) -> str:
    return json.dumps(payload) + "\n"


def normalize_budget(raw_budget: str) -> str:
    return raw_budget if raw_budget in {"low", "mid", "high"} else "mid"


def as_list_payload(payload) -> List[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]

    if isinstance(payload, dict):
        for key in ("results", "items", "memories", "facts", "based_on"):
            if isinstance(payload.get(key), list):
                return [item for item in payload[key] if isinstance(item, dict)]
        if "text" in payload or "content" in payload:
            return [payload]

    return []

def clean_hindsight_text(raw: str) -> str:
    text = (
        str(raw or "")
        .replace("\r", "")
        .replace("\t", " ")
        .replace("\u00a0", " ")
        .strip()
    )
    # Remove helper clauses such as "| When: ..." and "| Involving: ...".
    text = re.sub(r"\s*\|\s*(when|involving)\s*:[^|\n]*", "", text, flags=re.IGNORECASE)
    # Remove standalone helper lines if they appear outside pipe format.
    text = re.sub(r"^\s*(when|involving)\s*:[^\n]*\n?", "", text, flags=re.IGNORECASE | re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_html(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", str(raw or ""))
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def truncate_text(value: str, limit: int) -> str:
    clean = strip_html(value)
    return clean if len(clean) <= limit else clean[: limit - 1] + "…"


def normalize_section_name(section: str) -> str:
    mapping = {
        "people": "People",
        "person": "People",
        "groups": "Groups",
        "group": "Groups",
        "notes": "Notes",
        "note": "Notes",
    }
    return mapping.get(str(section or "").strip().lower(), "")


def sanitize_tag_list(tags: Any) -> List[str]:
    if not isinstance(tags, list):
        return []

    out: List[str] = []
    seen = set()
    invalid = {"none", "null", "n/a", "unknown", "undefined"}

    for tag in tags:
        clean = str(tag or "").strip()
        if not clean:
            continue
        lower = clean.lower()
        if lower in invalid:
            continue
        if lower in seen:
            continue
        seen.add(lower)
        out.append(clean[:80])

    return out


def build_data_digest(data: Dict[str, Any]) -> Dict[str, Any]:
    safe = data if isinstance(data, dict) else {}
    digest = {
        "people": [],
        "groups": [],
        "notes": [],
        "counts": {
            "people": 0,
            "groups": 0,
            "notes": 0,
        },
    }

    people = safe.get("People") if isinstance(safe.get("People"), list) else []
    groups = safe.get("Groups") if isinstance(safe.get("Groups"), list) else []
    notes = safe.get("Notes") if isinstance(safe.get("Notes"), list) else []

    digest["counts"]["people"] = len(people)
    digest["counts"]["groups"] = len(groups)
    digest["counts"]["notes"] = len(notes)

    for person in people[:90]:
        if not isinstance(person, dict):
            continue
        full_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        name = full_name or person.get("nickname") or "Unknown Person"
        extra_fields = person.get("extraFields") if isinstance(person.get("extraFields"), list) else []
        extras = []
        for pair in extra_fields[:8]:
            if not isinstance(pair, dict):
                continue
            key = str(pair.get("key", "")).strip()
            value = str(pair.get("value", "")).strip()
            if key and value:
                extras.append(f"{key}: {value}")

        digest["people"].append(
            {
                "id": str(person.get("id", ""))[:80],
                "name": name[:120],
                "birthday": str(person.get("birthday", ""))[:20],
                "last_edited": str(person.get("lastEdited", ""))[:40],
                "last_contacted": str(person.get("lastContacted", ""))[:40],
                "notes": truncate_text(person.get("notes", ""), 380),
                "extra_fields": extras,
            }
        )

    for group in groups[:60]:
        if not isinstance(group, dict):
            continue
        digest["groups"].append(
            {
                "id": str(group.get("id", ""))[:80],
                "name": str(group.get("name", "Untitled Group"))[:120],
                "members": [str(member)[:80] for member in (group.get("members") or [])[:40]],
                "last_edited": str(group.get("lastEdited", ""))[:40],
                "description": truncate_text(group.get("description", ""), 320),
            }
        )

    for note in notes[:120]:
        if not isinstance(note, dict):
            continue
        digest["notes"].append(
            {
                "id": str(note.get("id", ""))[:80],
                "title": str(note.get("title", "Untitled Note"))[:140],
                "last_edited": str(note.get("lastEdited", ""))[:40],
                "body": truncate_text(note.get("body", ""), 360),
            }
        )

    return digest


def extract_json_block(raw: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return "{}"

    # Strip code fences if present.
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return "{}"
    return text[start : end + 1]


def normalize_deep_insights(items: Any, data: Dict[str, Any], max_items: int) -> List[dict]:
    if not isinstance(items, list):
        return []

    max_items = max(1, min(int(max_items or 6), 12))
    section_ids = {
        "People": {str(p.get("id", "")) for p in (data.get("People") or []) if isinstance(p, dict)},
        "Groups": {str(g.get("id", "")) for g in (data.get("Groups") or []) if isinstance(g, dict)},
        "Notes": {str(n.get("id", "")) for n in (data.get("Notes") or []) if isinstance(n, dict)},
    }

    normalized: List[dict] = []
    seen_titles = set()

    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        if not title:
            continue

        dedupe_key = title.lower()
        if dedupe_key in seen_titles:
            continue
        seen_titles.add(dedupe_key)

        summary = str(item.get("summary") or item.get("description") or "").strip()
        if not summary:
            continue

        kind = str(item.get("kind", "deep")).strip().lower()
        if kind not in {"deep", "now", "connections", "risks", "watchlist"}:
            kind = "deep"

        try:
            confidence = float(item.get("confidence", 0.66))
        except Exception:
            confidence = 0.66
        confidence = clamp(confidence, 0.25, 0.99)

        freshness_days = item.get("freshnessDays", item.get("freshness_days"))
        try:
            freshness_days = int(freshness_days) if freshness_days is not None else None
        except Exception:
            freshness_days = None

        try:
            priority = int(item.get("priority", 78))
        except Exception:
            priority = 78
        priority = max(35, min(priority, 99))

        evidence_entries = []
        raw_evidence = item.get("evidence")
        if isinstance(raw_evidence, list):
            for entry in raw_evidence[:4]:
                if not isinstance(entry, dict):
                    continue
                source_section = normalize_section_name(entry.get("sourceSection") or entry.get("source_section"))
                source_id = str(entry.get("sourceId") or entry.get("source_id") or "").strip()
                if source_section and source_id and source_id not in section_ids.get(source_section, set()):
                    source_id = ""
                evidence_entries.append(
                    {
                        "label": str(entry.get("label", "Evidence"))[:120],
                        "sourceSection": source_section or "People",
                        "sourceId": source_id,
                        "timestamp": str(entry.get("timestamp", ""))[:40],
                        "snippet": clean_hindsight_text(str(entry.get("snippet", "")))[:320],
                    }
                )

        action = item.get("action") if isinstance(item.get("action"), dict) else {}
        source_section = normalize_section_name(action.get("sourceSection") or action.get("source_section"))
        source_id = str(action.get("sourceId") or action.get("source_id") or "").strip()
        if source_section and source_id and source_id not in section_ids.get(source_section, set()):
            source_id = ""

        if not (source_section and source_id):
            fallback = next((entry for entry in evidence_entries if entry.get("sourceSection") and entry.get("sourceId")), None)
            if fallback:
                source_section = fallback["sourceSection"]
                source_id = fallback["sourceId"]

        normalized.append(
            {
                "id": str(item.get("id") or f"deep-{idx}-{re.sub(r'[^a-zA-Z0-9]+', '-', title.lower())}".strip("-"))[:120],
                "title": title[:180],
                "summary": summary[:420],
                "kind": kind,
                "confidence": confidence,
                "freshnessDays": freshness_days,
                "evidence": evidence_entries,
                "why": str(item.get("why") or item.get("rationale") or "").strip()[:820],
                "action": {
                    "label": str(action.get("label") or "Open Source")[:40],
                    "sourceSection": source_section,
                    "sourceId": source_id,
                } if (source_section and source_id) else None,
                "priority": priority,
                "validTo": str(item.get("validTo") or item.get("valid_to") or "")[:40] or None,
            }
        )

        if len(normalized) >= max_items:
            break

    return normalized


def section_from_type(raw_type: str) -> str:
    mapping = {
        "person": "People",
        "people": "People",
        "group": "Groups",
        "groups": "Groups",
        "note": "Notes",
        "notes": "Notes",
    }
    return mapping.get(str(raw_type or "").strip().lower(), "")


def section_from_tags(tags: Any) -> str:
    for tag in sanitize_tag_list(tags):
        raw = str(tag or "").strip().lower()
        if raw.startswith("section:"):
            return section_from_type(raw.split(":", 1)[1])
    return ""


def parse_datetime(raw: str) -> Optional[datetime]:
    if not raw:
        return None
    value = str(raw).strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def memory_item_to_evidence(item: dict, idx: int = 0) -> Optional[dict]:
    if not isinstance(item, dict):
        return None

    snippet = clean_hindsight_text(item.get("text") or item.get("content") or "")
    if not snippet:
        return None

    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    tags = sanitize_tag_list(item.get("tags"))
    source_section = (
        section_from_type(metadata.get("type"))
        or section_from_tags(tags)
        or ""
    )
    source_id = str(item.get("document_id") or metadata.get("source_id") or "").strip()

    timestamp = (
        item.get("occurred_start")
        or item.get("mentioned_at")
        or item.get("timestamp")
        or item.get("created_at")
        or ""
    )

    label = str(
        item.get("type")
        or item.get("fact_type")
        or metadata.get("type")
        or f"Memory {idx + 1}"
    ).strip()

    return {
        "label": label[:120] or "Memory",
        "sourceSection": source_section or "People",
        "sourceId": source_id,
        "timestamp": str(timestamp)[:40],
        "snippet": snippet[:320],
    }


async def recall_memories_raw(query: str, budget: str, max_tokens: int = 1200) -> List[dict]:
    if not http_client:
        return []

    payload = {"query": query, "budget": budget, "max_tokens": max_tokens}
    urls = [
        f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/memories/recall",
        f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/recall",
    ]

    response = None
    last_error = None
    for url in urls:
        try:
            candidate = await http_client.post(url, json=payload, timeout=8.0)
            if candidate.status_code == 404:
                last_error = httpx.HTTPStatusError(
                    "404 Not Found",
                    request=candidate.request,
                    response=candidate,
                )
                continue
            candidate.raise_for_status()
            response = candidate
            break
        except Exception as exc:
            last_error = exc

    if response is None:
        if last_error:
            print(f"Recall evidence warning: {last_error}")
        return []

    content_type = response.headers.get("content-type") or ""
    payload_data = response.json() if "application/json" in content_type else []
    return as_list_payload(payload_data)


def build_reflect_insight_schema(max_items: int) -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "insights": {
                "type": "array",
                "maxItems": max_items,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "id": {"type": "string"},
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                        "why": {"type": "string"},
                        "kind": {"type": "string"},
                        "confidence": {"type": "number"},
                        "freshnessDays": {"type": "integer"},
                        "priority": {"type": "integer"},
                        "validTo": {"type": "string"},
                        "action": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "label": {"type": "string"},
                                "sourceSection": {"type": "string"},
                                "sourceId": {"type": "string"},
                            },
                            "required": ["label", "sourceSection", "sourceId"],
                        },
                        "evidence": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "label": {"type": "string"},
                                    "sourceSection": {"type": "string"},
                                    "sourceId": {"type": "string"},
                                    "timestamp": {"type": "string"},
                                    "snippet": {"type": "string"},
                                },
                                "required": ["label", "snippet"],
                            },
                        },
                    },
                    "required": ["title", "summary"],
                },
            }
        },
        "required": ["insights"],
    }


async def fetch_structured_reflect_insights(budget: str, max_items: int) -> tuple[List[dict], str]:
    if not http_client:
        return [], ""

    schema = build_reflect_insight_schema(max_items)
    query = (
        "Generate deep relationship intelligence from this CRM memory bank. "
        "Find non-obvious opportunities, risks, and timing-sensitive mismatches. "
        "Be temporally accurate: avoid stale asks unless still active. "
        "Prioritize cross-record synthesis over obvious reminders."
    )

    payload = {
        "query": query,
        "budget": budget,
        "mode": "precision",
        "max_tokens": 2600,
        "response_schema": schema,
    }

    response = await http_client.post(
        f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/reflect",
        json=payload,
    )
    response.raise_for_status()

    content_type = response.headers.get("content-type") or ""
    data = response.json() if "application/json" in content_type else {}
    if not isinstance(data, dict):
        return [], ""

    reflect_text = clean_hindsight_text(data.get("text", ""))
    insights: List[dict] = []
    structured = data.get("structured_output")
    if isinstance(structured, dict) and isinstance(structured.get("insights"), list):
        insights = [item for item in structured.get("insights", []) if isinstance(item, dict)]
    elif isinstance(structured, list):
        insights = [item for item in structured if isinstance(item, dict)]
    elif isinstance(data.get("insights"), list):
        insights = [item for item in data.get("insights", []) if isinstance(item, dict)]
    elif isinstance(structured, str):
        try:
            parsed_structured = json.loads(extract_json_block(structured))
            if isinstance(parsed_structured.get("insights"), list):
                insights = [item for item in parsed_structured.get("insights", []) if isinstance(item, dict)]
        except Exception:
            insights = []

    if not insights and reflect_text:
        try:
            parsed_text = json.loads(extract_json_block(reflect_text))
            if isinstance(parsed_text.get("insights"), list):
                insights = [item for item in parsed_text.get("insights", []) if isinstance(item, dict)]
        except Exception:
            pass

    return insights, reflect_text


async def enrich_deep_insights_with_recall(insights: List[dict], budget: str) -> List[dict]:
    async def enrich_one(item: dict) -> dict:
        insight = dict(item)
        evidence = insight.get("evidence") if isinstance(insight.get("evidence"), list) else []
        seen_snippets = {str(entry.get("snippet", "")).strip().lower() for entry in evidence if isinstance(entry, dict)}

        recall_query = f"{insight.get('title', '')}. {insight.get('summary', '')}".strip()
        if recall_query:
            raw_items = await recall_memories_raw(recall_query, budget, max_tokens=900)
            for idx, raw in enumerate(raw_items[:3]):
                ev = memory_item_to_evidence(raw, idx)
                if not ev:
                    continue
                key = ev["snippet"].strip().lower()
                if key in seen_snippets:
                    continue
                seen_snippets.add(key)
                evidence.append(ev)

        insight["evidence"] = evidence[:4]

        if not insight.get("action"):
            fallback = next(
                (
                    entry
                    for entry in insight["evidence"]
                    if isinstance(entry, dict) and entry.get("sourceSection") and entry.get("sourceId")
                ),
                None,
            )
            if fallback:
                insight["action"] = {
                    "label": "Open Source",
                    "sourceSection": fallback["sourceSection"],
                    "sourceId": fallback["sourceId"],
                }

        if insight.get("freshnessDays") is None:
            timestamps = [
                parse_datetime(entry.get("timestamp"))
                for entry in insight["evidence"]
                if isinstance(entry, dict) and entry.get("timestamp")
            ]
            timestamps = [ts for ts in timestamps if ts]
            if timestamps:
                newest = max(timestamps)
                delta_days = max(0, (datetime.now(timezone.utc) - newest).days)
                insight["freshnessDays"] = delta_days

        return insight

    head = insights[:3]
    tail = insights[3:]
    enriched_head = await asyncio.gather(*(enrich_one(insight) for insight in head))
    return [*enriched_head, *tail]


def normalize_memory_item(item: dict, fallback_title: str = "Memory") -> dict:
    text = clean_hindsight_text(item.get("text") or item.get("content") or "")
    title = (item.get("type") or item.get("fact_type") or fallback_title or "Memory").strip()
    timestamp = (
        item.get("occurred_start")
        or item.get("mentioned_at")
        or item.get("timestamp")
        or item.get("created_at")
        or ""
    )
    context = item.get("context") or item.get("source") or ""
    tags = sanitize_tag_list(item.get("tags"))

    return {
        "title": title,
        "text": text[:500],
        "timestamp": str(timestamp)[:40],
        "context": str(context)[:120],
        "tags": [str(t) for t in tags[:6]],
    }


def infer_insight_kind(text: str) -> str:
    lower = str(text or "").lower()
    if re.search(r"\brisk\b|\bconflict\b|\bblocked\b|\bmiss(?:ed|ing)?\b|\bstale\b", lower):
        return "risks"
    if re.search(r"\bintro(?:duction)?\b|\bconnect(?:ion|ing)?\b|\bmatch(?:ing)?\b", lower):
        return "connections"
    if re.search(r"\btoday\b|\btomorrow\b|\bthis week\b|\bnext week\b|\bdue\b|\bsoon\b|\bbefore\b", lower):
        return "now"
    return "deep"


def build_action_candidates(data: Dict[str, Any]) -> List[dict]:
    candidates: List[dict] = []

    people = data.get("People") if isinstance(data.get("People"), list) else []
    groups = data.get("Groups") if isinstance(data.get("Groups"), list) else []
    notes = data.get("Notes") if isinstance(data.get("Notes"), list) else []

    for person in people:
        if not isinstance(person, dict):
            continue
        person_id = str(person.get("id") or "").strip()
        if not person_id:
            continue
        full_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        nickname = str(person.get("nickname") or "").strip()
        names = [full_name, nickname]
        for name in names:
            if not name:
                continue
            candidates.append(
                {
                    "needle": name.lower(),
                    "section": "People",
                    "source_id": person_id,
                    "label": "Open Profile",
                }
            )

    for group in groups:
        if not isinstance(group, dict):
            continue
        group_id = str(group.get("id") or "").strip()
        group_name = str(group.get("name") or "").strip()
        if group_id and group_name:
            candidates.append(
                {
                    "needle": group_name.lower(),
                    "section": "Groups",
                    "source_id": group_id,
                    "label": "Open Group",
                }
            )

    for note in notes:
        if not isinstance(note, dict):
            continue
        note_id = str(note.get("id") or "").strip()
        note_title = str(note.get("title") or "").strip()
        if note_id and note_title:
            candidates.append(
                {
                    "needle": note_title.lower(),
                    "section": "Notes",
                    "source_id": note_id,
                    "label": "Open Note",
                }
            )

    candidates.sort(key=lambda item: len(item["needle"]), reverse=True)
    return candidates


def pick_action_for_text(text: str, candidates: List[dict]) -> Optional[dict]:
    lower = str(text or "").lower()
    if not lower:
        return None
    for candidate in candidates:
        needle = candidate.get("needle")
        if not needle:
            continue
        if needle in lower:
            return {
                "label": candidate.get("label", "Open Source"),
                "sourceSection": candidate.get("section", ""),
                "sourceId": candidate.get("source_id", ""),
            }
    return None


def parse_reflect_text_to_insights(reflect_text: str, data: Dict[str, Any], max_items: int) -> List[dict]:
    clean_text = clean_hindsight_text(reflect_text)
    if not clean_text:
        return []

    max_items = max(1, min(int(max_items or 6), 12))
    candidates = build_action_candidates(data)
    now_iso = datetime.now(timezone.utc).isoformat()

    lines = [line.strip() for line in clean_text.splitlines() if line.strip()]
    segments: List[str] = []
    current: List[str] = []

    for line in lines:
        marker = line.lstrip()
        is_head = bool(
            marker.startswith("#")
            or marker.startswith("- ")
            or marker.startswith("* ")
            or marker.startswith("• ")
            or re.match(r"^\d+[\.\)]\s+", marker)
        )
        normalized = re.sub(r"^(?:#{1,6}|[-*\u2022]|\d+[\.\)])\s*", "", marker).strip()
        if not normalized:
            continue

        if is_head and current:
            segments.append(" ".join(current))
            current = [normalized]
        else:
            current.append(normalized)

    if current:
        segments.append(" ".join(current))

    if not segments:
        segments = [clean_text]

    items: List[dict] = []
    seen = set()

    for idx, segment in enumerate(segments):
        cleaned_segment = clean_hindsight_text(segment)
        if len(cleaned_segment) < 24:
            continue

        title_candidate = re.split(r"[.!?]\s+|:\s+", cleaned_segment, maxsplit=1)[0].strip()
        title = truncate_text(title_candidate or f"Signal {idx + 1}", 150)
        summary = truncate_text(cleaned_segment, 420)

        dedupe_key = f"{title.lower()}|{summary[:80].lower()}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        action = pick_action_for_text(cleaned_segment, candidates)
        evidence = []
        if action:
            evidence.append(
                {
                    "label": "Reflect signal",
                    "sourceSection": action.get("sourceSection"),
                    "sourceId": action.get("sourceId"),
                    "timestamp": now_iso,
                    "snippet": summary,
                }
            )

        kind = infer_insight_kind(cleaned_segment)
        priority = 88 if kind == "now" else (84 if kind == "risks" else 78)

        items.append(
            {
                "id": f"reflect-text-{idx}-{re.sub(r'[^a-zA-Z0-9]+', '-', title.lower()).strip('-')}"[:120],
                "title": title,
                "summary": summary,
                "why": cleaned_segment[:820],
                "kind": kind,
                "confidence": 0.72,
                "freshnessDays": 0,
                "priority": priority,
                "action": action,
                "evidence": evidence,
                "validTo": None,
            }
        )

        if len(items) >= max_items:
            break

    return items


def build_memory_context(items: List[dict], reflect_text: str = "") -> str:
    if not items and not reflect_text:
        return ""

    lines = [
        "# Memory Context",
        f"Current time (UTC): {datetime.now(timezone.utc).isoformat()}",
    ]

    if reflect_text:
        lines.append("Reflect summary:")
        lines.append(reflect_text[:1500])

    if items:
        lines.append("Relevant memory records:")
        for idx, item in enumerate(items[:10], start=1):
            text = item.get("text") or "No content"
            parts = [f"{idx}. {text}"]
            if item.get("context"):
                parts.append(f"[context: {item['context']}]")
            if item.get("timestamp"):
                parts.append(f"[time: {item['timestamp']}]")
            lines.append(" ".join(parts))

    lines.append("Use this context only when relevant and avoid inventing details.")
    return "\n".join(lines)


async def fetch_hindsight_context(
    query: str,
    budget: str,
    use_reflect: bool,
) -> tuple[str, List[dict], str]:
    if not http_client:
        return "", [], ""

    if use_reflect:
        payload = {"query": query, "budget": budget}

        url = f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/reflect"
        response = await http_client.post(url, json=payload)
        response.raise_for_status()

        data = response.json() if "application/json" in (response.headers.get("content-type") or "") else {}
        reflect_text = clean_hindsight_text(data.get("text", "")) if isinstance(data, dict) else ""
        evidence = as_list_payload(data)
        items = [normalize_memory_item(item, "Reflect Fact") for item in evidence]

        if reflect_text and not items:
            items = [{"title": "Reflect Summary", "text": reflect_text[:500], "timestamp": "", "context": "reflect", "tags": []}]

        return build_memory_context(items, reflect_text), items, reflect_text

    payload = {"query": query, "budget": budget, "max_tokens": 2200}

    # Newer Hindsight versions expose recall under /memories/recall.
    # Keep a fallback to /recall for older deployments.
    urls = [
        f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/memories/recall",
        f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/recall",
    ]
    last_error = None
    response = None
    for url in urls:
        try:
            response = await http_client.post(url, json=payload)
            if response.status_code == 404:
                last_error = httpx.HTTPStatusError(
                    "404 Not Found",
                    request=response.request,
                    response=response,
                )
                continue
            response.raise_for_status()
            break
        except Exception as e:
            last_error = e
            response = None

    if response is None:
        raise last_error or RuntimeError("Recall endpoint unavailable")

    content_type = response.headers.get("content-type") or ""
    data = response.json() if "application/json" in content_type else []
    items = [normalize_memory_item(item) for item in as_list_payload(data)]

    return build_memory_context(items), items, ""


async def store_chat_memory(session_id: str, user_text: str, assistant_text: str):
    if not http_client:
        return

    convo_text = f"USER: {user_text}\nASSISTANT: {assistant_text}"
    chat_tags = sanitize_tag_list(
        [
            "section:notes",
            "context:chat_session",
            "type:chat_turn",
            f"session:{session_id}",
        ]
    )
    payload = {
        "items": [
            {
                "content": convo_text,
                "document_id": f"chat-{session_id}",
                "metadata": {
                    "source": "Organizer Agent",
                    "session_id": session_id,
                    "type": "chat_turn",
                },
                "context": "chat_session",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "tags": chat_tags,
            }
        ],
        "document_tags": chat_tags,
        "async": True,
    }

    try:
        await http_client.post(f"{HINDSIGHT_URL}/v1/default/banks/{BANK_ID}/memories", json=payload)
    except Exception as e:
        print(f"Store memory warning: {e}")


@app.post("/insights/deep")
async def deep_insights_endpoint(req: DeepInsightsRequest):
    safe_budget = normalize_budget(req.reasoning_budget)
    max_items = max(2, min(req.max_items, 10))
    raw_data = req.data if isinstance(req.data, dict) else {}
    reflect_text = ""
    if not (req.use_reflect and http_client):
        return {
            "insights": [],
            "reflect_summary": "",
            "error": "Reflect mode or memory client unavailable",
        }

    try:
        raw_items, reflect_text = await fetch_structured_reflect_insights(safe_budget, max_items)
        source = "hindsight-reflect-structured"

        # Some Hindsight versions ignore response_schema and return prose only.
        # In that case we still use the same reflect response to derive structured insights.
        if not raw_items and reflect_text:
            raw_items = parse_reflect_text_to_insights(reflect_text, raw_data, max_items)
            source = "hindsight-reflect-derived"

        normalized = normalize_deep_insights(raw_items, raw_data, max_items)
        if not normalized:
            return {
                "insights": [],
                "reflect_summary": reflect_text[:1000],
                "error": "Reflect returned no parseable insights",
            }

        needs_recall_enrichment = any(
            not (isinstance(item.get("evidence"), list) and item.get("evidence"))
            for item in normalized
            if isinstance(item, dict)
        )
        enriched = await enrich_deep_insights_with_recall(normalized, safe_budget) if needs_recall_enrichment else normalized
        return {
            "insights": enriched,
            "reflect_summary": reflect_text[:1000],
            "source": source,
        }
    except Exception as exc:
        print(f"Deep insight reflect warning: {exc}")
        return {"insights": [], "reflect_summary": reflect_text[:1000], "error": str(exc)}


# --- 4. ROUTES ---
@app.get("/")
async def read_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    async def event_generator() -> AsyncIterator[str]:
        if not openai_client:
            yield stream_line({"type": "error", "content": "OpenAI client is not configured."})
            return

        # Session history setup
        if req.session_id not in sessions:
            sessions[req.session_id] = [{"role": "system", "content": "You are a helpful assistant."}]

        history = sessions[req.session_id]
        history.append({"role": "user", "content": req.message})

        # Keep context manageable
        if len(history) > 20:
            history = history[-20:]
            if history[0]["role"] != "system":
                history.insert(0, {"role": "system", "content": "You are a helpful assistant."})

        sessions[req.session_id] = history

        safe_budget = normalize_budget(req.reasoning_budget)

        memory_context = ""
        hindsight_items: List[dict] = []
        reflect_text = ""

        memory_task = "reflecting" if req.use_reflect else "recalling_memories"
        yield stream_line({"type": "task", "task": memory_task, "detail": "Querying memory bank"})

        try:
            memory_context, hindsight_items, reflect_text = await fetch_hindsight_context(
                query=req.message,
                budget=safe_budget,
                use_reflect=req.use_reflect,
            )
            detail = f"Retrieved {len(hindsight_items)} item(s)"
            if req.use_reflect and reflect_text:
                detail = f"Reflect summary + {len(hindsight_items)} item(s)"
            yield stream_line({"type": "status", "task": memory_task, "content": detail})
            yield stream_line({"type": "hindsight_output", "content": hindsight_items})
        except Exception as e:
            print(f"Hindsight recall warning: {e}")
            yield stream_line(
                {
                    "type": "status",
                    "task": memory_task,
                    "content": f"Memory bank unavailable: {str(e)}",
                }
            )
            yield stream_line({"type": "hindsight_output", "content": []})

        messages_for_model = list(history)
        if memory_context:
            insertion_index = 1 if messages_for_model and messages_for_model[0].get("role") == "system" else 0
            messages_for_model.insert(insertion_index, {"role": "system", "content": memory_context})

        yield stream_line({"type": "task", "task": "generating_response", "detail": f"Running {MODEL_NAME}"})

        full_answer = ""
        try:
            stream = await openai_client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages_for_model,
                stream=True,
            )

            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    text = chunk.choices[0].delta.content
                    full_answer += text
                    yield stream_line({"type": "result", "content": text})
        except Exception as e:
            print(f"Chat Error: {e}")
            yield stream_line({"type": "error", "content": str(e)})
            return

        history.append({"role": "assistant", "content": full_answer})
        sessions[req.session_id] = history

        if req.persist_memory:
            yield stream_line({"type": "task", "task": "storing_memory", "detail": "Persisting conversation"})
            await store_chat_memory(req.session_id, req.message, full_answer)
        else:
            yield stream_line({"type": "status", "task": "storing_memory", "content": "Memory save disabled"})
        yield stream_line({"type": "task", "task": "complete", "detail": "Done"})

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")


# --- 5. HINDSIGHT PROXY (Required for Graph UI) ---
@app.api_route("/v1/{path:path}", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
async def proxy_to_hindsight(path: str, request: Request):
    global http_client
    url = f"{HINDSIGHT_URL}/v1/{path}"

    try:
        body = await request.body()
        forward_headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in ["host", "content-length"]
        }

        req_proxy = http_client.build_request(
            request.method,
            url,
            headers=forward_headers,
            content=body
        )

        r = await http_client.send(req_proxy, stream=True)

        return StreamingResponse(
            r.aiter_raw(),
            status_code=r.status_code,
            headers={k: v for k, v in r.headers.items() if k.lower() != "content-length"},
            background=r.aclose
        )
    except Exception as e:
        print(f"PROXY ERROR: {e}")
        return JSONResponse(status_code=500, content={"error": "Proxy Error", "details": str(e)})


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
