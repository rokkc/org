import { appSettings, getStoredData } from '../core/store.js';
import { sanitizeHtml } from '../core/utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INSIGHT_LOG_KEY = 'organizer-insight-log-v2';
const INSIGHT_LOG_VERSION = 2;
const MAX_LOG_ENTRIES = 320;
const SCAN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ERROR_RETRY_MS = 45 * 1000;
const DEEP_FETCH_LIMIT = 8;

let insightIndex = new Map();
let activeInsightId = null;
let scanPromise = null;
let runtimeState = {
    loading: false,
    error: '',
    source: '',
    lastScanAt: ''
};

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function escapeHtml(value = '') {
    return value
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripHtml(value = '') {
    if (!value) return '';
    const div = document.createElement('div');
    div.innerHTML = value;
    return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
}

function parseMarkdown(text = '') {
    const safeText = String(text || '');
    const html = (typeof marked !== 'undefined')
        ? marked.parse(safeText)
        : escapeHtml(safeText).replace(/\n/g, '<br>');
    return sanitizeHtml(html);
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function toDateOnly(d) {
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDate(value) {
    const d = parseDate(value);
    if (!d) return 'Unknown date';
    return d.toISOString().slice(0, 10);
}

function daysBetween(newerDate, olderDate) {
    if (!newerDate || !olderDate) return null;
    return Math.floor((newerDate.getTime() - olderDate.getTime()) / DAY_MS);
}

function freshnessLabel(days) {
    if (days == null) return 'Unknown';
    if (days <= 2) return 'Immediate';
    if (days <= 14) return 'Soon';
    if (days <= 60) return 'Recent';
    if (days <= 180) return 'Aging';
    return 'Stale';
}

function safeNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function truncateText(value = '', max = 280) {
    const text = String(value || '').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

function slug(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 90);
}

function createInsightId(prefix = 'insight') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildDataFingerprint(data) {
    const people = (data.People || []).map((p) => [p.id, p.lastEdited || '', p.lastContacted || ''].join(':')).join('|');
    const groups = (data.Groups || []).map((g) => [g.id, g.lastEdited || ''].join(':')).join('|');
    const notes = (data.Notes || []).map((n) => [n.id, n.lastEdited || ''].join(':')).join('|');
    return [
        people.length,
        groups.length,
        notes.length,
        people.slice(0, 500),
        groups.slice(0, 240),
        notes.slice(0, 360)
    ].join('::');
}

function createEmptyLogState() {
    return {
        version: INSIGHT_LOG_VERSION,
        fingerprint: '',
        lastScanAt: '',
        entries: []
    };
}

function normalizeEvidence(entry, index = 0) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        label: String(entry.label || `Evidence ${index + 1}`).slice(0, 120),
        sourceSection: String(entry.sourceSection || '').slice(0, 20),
        sourceId: String(entry.sourceId || '').slice(0, 120),
        timestamp: String(entry.timestamp || '').slice(0, 40),
        snippet: truncateText(entry.snippet || '', 420)
    };
}

function buildDedupeKey(item) {
    const action = item.action || {};
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    const evidenceKey = evidence
        .slice(0, 2)
        .map((entry) => `${String(entry.sourceSection || '').toLowerCase()}:${String(entry.sourceId || '').toLowerCase()}`)
        .join('|');

    return [
        slug(item.kind || 'deep'),
        slug(stripHtml(item.title || '')),
        slug(stripHtml(item.summary || '')),
        `${String(action.sourceSection || '').toLowerCase()}:${String(action.sourceId || '').toLowerCase()}`,
        evidenceKey
    ].join('|').slice(0, 500);
}

function normalizeDeepInsightItem(item, index) {
    if (!item || typeof item !== 'object') return null;

    const title = String(item.title || '').trim();
    const summary = String(item.summary || item.description || '').trim();
    if (!title || !summary) return null;

    const rawKind = String(item.kind || 'deep').toLowerCase();
    let kind = 'deep';
    if (rawKind.includes('risk')) kind = 'risks';
    else if (rawKind.includes('time')) kind = 'time';
    else if (rawKind.includes('now')) kind = 'now';
    else if (rawKind.includes('connection') || rawKind.includes('intro')) kind = 'connections';

    const evidence = Array.isArray(item.evidence)
        ? item.evidence.map((entry, evIndex) => normalizeEvidence(entry, evIndex)).filter(Boolean).slice(0, 5)
        : [];

    const action = item.action && typeof item.action === 'object'
        ? {
            label: String(item.action.label || 'Open Source').slice(0, 48),
            sourceSection: String(item.action.sourceSection || '').slice(0, 20),
            sourceId: String(item.action.sourceId || '').slice(0, 120)
        }
        : null;

    const normalized = {
        id: String(item.id || `deep-${index}-${slug(title)}`).slice(0, 120),
        title: truncateText(title, 190),
        summary: truncateText(summary, 500),
        kind,
        confidence: clamp(safeNumber(item.confidence, 0.66), 0.25, 0.99),
        freshnessDays: safeNumber(item.freshnessDays ?? item.freshness_days, null),
        evidence,
        why: truncateText(item.why || item.rationale || '', 1200),
        action: action && action.sourceSection && action.sourceId ? action : null,
        secondaryAction: null,
        priority: clamp(Math.round(safeNumber(item.priority, 78)), 30, 99),
        validTo: item.validTo || item.valid_to || null,
        dueDate: item.dueDate || item.due_date || null,
        sourceType: 'deep'
    };

    normalized.dedupeKey = buildDedupeKey(normalized);
    return normalized;
}

function loadInsightLogState() {
    const raw = localStorage.getItem(INSIGHT_LOG_KEY);
    if (!raw) return createEmptyLogState();

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== INSIGHT_LOG_VERSION || !Array.isArray(parsed.entries)) {
            return createEmptyLogState();
        }
        return parsed;
    } catch {
        return createEmptyLogState();
    }
}

function saveInsightLogState(state) {
    localStorage.setItem(INSIGHT_LOG_KEY, JSON.stringify(state));
}

function pruneLogEntries(entries = []) {
    return [...entries]
        .sort((a, b) => (parseDate(b.firstSeenAt)?.getTime() || 0) - (parseDate(a.firstSeenAt)?.getTime() || 0))
        .slice(0, MAX_LOG_ENTRIES);
}

function mergeLogEntries(state, incomingItems, sourceType = 'deep') {
    if (!Array.isArray(incomingItems) || !incomingItems.length) return state;

    const nowIso = new Date().toISOString();
    const byKey = new Map();
    const entries = Array.isArray(state.entries) ? [...state.entries] : [];

    entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const key = entry.dedupeKey || buildDedupeKey(entry);
        if (key) byKey.set(key, entry);
    });

    incomingItems.forEach((item) => {
        const key = item.dedupeKey || buildDedupeKey(item);
        if (!key) return;

        const existing = byKey.get(key);
        if (existing) {
            existing.title = item.title;
            existing.summary = item.summary;
            existing.why = item.why || existing.why;
            existing.kind = item.kind || existing.kind;
            existing.confidence = item.confidence ?? existing.confidence;
            existing.freshnessDays = item.freshnessDays ?? existing.freshnessDays;
            existing.evidence = item.evidence || existing.evidence;
            existing.action = item.action || existing.action;
            existing.secondaryAction = item.secondaryAction || existing.secondaryAction;
            existing.priority = item.priority ?? existing.priority;
            existing.validTo = item.validTo ?? existing.validTo;
            existing.dueDate = item.dueDate ?? existing.dueDate;
            existing.sourceType = sourceType;
            existing.lastSeenAt = nowIso;
            existing.lastUpdatedAt = nowIso;
            return;
        }

        const nextEntry = {
            ...item,
            id: item.id || createInsightId(sourceType === 'cadence' ? 'cadence' : 'deep'),
            dedupeKey: key,
            sourceType,
            firstSeenAt: nowIso,
            lastSeenAt: nowIso,
            lastUpdatedAt: nowIso
        };

        entries.unshift(nextEntry);
        byKey.set(key, nextEntry);
    });

    state.entries = pruneLogEntries(entries);
    return state;
}

function parseBirthdayDate(raw = '', now = new Date()) {
    const match = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!month || !day) return null;

    const currentYear = now.getFullYear();
    let birthday = new Date(currentYear, month - 1, day);
    if (birthday.getMonth() !== month - 1 || birthday.getDate() !== day) return null;

    const today = toDateOnly(now);
    const birthdayDateOnly = toDateOnly(birthday);
    if (birthdayDateOnly < today) {
        birthday = new Date(currentYear + 1, month - 1, day);
    }

    return birthday;
}

function getPersonName(person = {}) {
    const full = `${person.firstName || ''} ${person.lastName || ''}`.trim();
    return full || person.nickname || 'Unknown Person';
}

function buildBirthdayCadenceSignals(data, now = new Date()) {
    const people = Array.isArray(data.People) ? data.People : [];
    const today = toDateOnly(now);
    const phases = [
        {
            daysBefore: 14,
            code: 'prep-14',
            title: 'Birthday Prep Window',
            summary: 'Two weeks out. Consider gift ideas and any plan logistics.',
            why: '- Review preferences from prior notes.\n- Decide whether to gift, call, or plan an outing.\n- Set calendar reminder for final check next week.'
        },
        {
            daysBefore: 7,
            code: 'prep-7',
            title: 'Birthday Plan Checkpoint',
            summary: 'One week out. Finalize gift or message plan.',
            why: '- Confirm delivery or reservation timing.\n- Draft a personal message while context is fresh.'
        },
        {
            daysBefore: 1,
            code: 'day-before',
            title: 'Birthday Is Tomorrow',
            summary: 'Final reminder to reach out tomorrow.',
            why: '- Queue the message now.\n- Confirm your reminder time for tomorrow morning.'
        },
        {
            daysBefore: 0,
            code: 'today',
            title: 'Birthday Today',
            summary: 'Send birthday wishes today.',
            why: '- Send the message now.\n- If appropriate, follow up with a call later today.'
        }
    ];

    const out = [];

    people.forEach((person) => {
        if (!person?.id || !person?.birthday) return;

        const birthday = parseBirthdayDate(person.birthday, now);
        if (!birthday) return;

        const daysUntil = daysBetween(toDateOnly(birthday), today);
        const name = getPersonName(person);

        phases.forEach((phase) => {
            if (daysUntil !== phase.daysBefore) return;

            const birthdayDate = birthday.toISOString().slice(0, 10);
            const dueDate = birthday.toISOString();
            const year = birthday.getFullYear();
            const dedupeKey = `birthday|${person.id}|${year}|${phase.code}`;

            out.push({
                id: `birthday-${person.id}-${year}-${phase.code}`,
                dedupeKey,
                title: `${name}: ${phase.title}`,
                summary: `${phase.summary} (${birthdayDate})`,
                kind: 'time',
                confidence: 0.97,
                freshnessDays: daysUntil,
                evidence: [
                    {
                        label: `${name} profile`,
                        sourceSection: 'People',
                        sourceId: person.id,
                        timestamp: person.birthday,
                        snippet: `- Birthday: **${person.birthday}**\n- Reminder window: **${phase.daysBefore} day(s) before**`
                    }
                ],
                why: `### Recommended action\n${phase.why}`,
                action: {
                    label: 'Open Profile',
                    sourceSection: 'People',
                    sourceId: person.id
                },
                secondaryAction: null,
                priority: phase.daysBefore === 0 ? 99 : (phase.daysBefore === 1 ? 96 : 90),
                validTo: dueDate,
                dueDate,
                sourceType: 'cadence'
            });
        });
    });

    return out;
}

function applyCadenceSignalsToLog(state, data) {
    const cadenceSignals = buildBirthdayCadenceSignals(data, new Date());
    if (!cadenceSignals.length) return state;
    return mergeLogEntries(state, cadenceSignals, 'cadence');
}

async function fetchPipelineInsights(data, options = {}) {
    if (scanPromise) return scanPromise;

    runtimeState.loading = true;
    runtimeState.error = '';

    const includeDeep = options.includeDeep !== false;
    const forceScan = !!options.forceScan;

    scanPromise = fetch('/insights/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data,
            max_items: DEEP_FETCH_LIMIT,
            reasoning_budget: appSettings.reasoningBudget || 'mid',
            use_reflect: includeDeep,
            force: forceScan
        })
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error(`Insight pipeline failed (${response.status})`);
            }
            const payload = await response.json();
            return {
                entries: Array.isArray(payload?.entries) ? payload.entries : [],
                source: String(payload?.source || '').slice(0, 120),
                error: String(payload?.error || ''),
                lastScanAt: String(payload?.lastScanAt || '')
            };
        })
        .finally(() => {
            runtimeState.loading = false;
            scanPromise = null;
        });

    return scanPromise;
}

function computeDueDays(entry, now) {
    const dueDate = parseDate(entry.dueDate || entry.validTo);
    if (!dueDate) return null;
    return daysBetween(toDateOnly(dueDate), toDateOnly(now));
}

function buildInsightsModel(state, options = {}) {
    const now = new Date();
    const allEntries = Array.isArray(state.entries)
        ? [...state.entries].sort((a, b) => {
            const pDelta = (b.priority || 0) - (a.priority || 0);
            if (pDelta !== 0) return pDelta;
            return (parseDate(b.lastSeenAt)?.getTime() || 0) - (parseDate(a.lastSeenAt)?.getTime() || 0);
        })
        : [];
    const activeEntries = allEntries.filter((entry) => !['expired', 'resolved'].includes(String(entry.status || 'active').toLowerCase()));

    const sections = {
        next: [],
        upcoming: [],
        strategic: [],
        risks: [],
        log: []
    };

    activeEntries.forEach((entry) => {
        const dueDays = computeDueDays(entry, now);
        const textBlob = `${entry.title || ''} ${entry.summary || ''}`.toLowerCase();
        const isRisk = String(entry.kind || '').toLowerCase().includes('risk') || /\brisk\b|\bconflict\b|\bmiss\b|\bstale\b/.test(textBlob);

        if (dueDays != null && dueDays >= 0 && dueDays <= 2) {
            sections.next.push(entry);
        } else if (dueDays != null && dueDays >= 3 && dueDays <= 14) {
            sections.upcoming.push(entry);
        } else if (isRisk) {
            sections.risks.push(entry);
        } else {
            sections.strategic.push(entry);
        }
    });

    sections.log = [...allEntries]
        .sort((a, b) => (parseDate(b.firstSeenAt)?.getTime() || 0) - (parseDate(a.firstSeenAt)?.getTime() || 0));

    const limits = {
        next: options.embedded ? 3 : 6,
        upcoming: options.embedded ? 3 : 6,
        strategic: options.embedded ? 4 : 8,
        risks: options.embedded ? 3 : 6,
        log: options.embedded ? 4 : 10
    };

    Object.keys(limits).forEach((key) => {
        sections[key] = sections[key].slice(0, limits[key]);
    });

    const dueSoonCount = activeEntries.filter((entry) => {
        const dueDays = computeDueDays(entry, now);
        return dueDays != null && dueDays >= 0 && dueDays <= 14;
    }).length;

    const recentCount = activeEntries.filter((entry) => {
        const firstSeen = parseDate(entry.firstSeenAt);
        return firstSeen && daysBetween(toDateOnly(now), toDateOnly(firstSeen)) <= 7;
    }).length;

    const summary = {
        active: activeEntries.length,
        dueSoon: dueSoonCount,
        risks: sections.risks.length,
        logged: allEntries.length,
        recent: recentCount
    };

    return {
        sections,
        summary,
        generatedAt: new Date().toISOString()
    };
}

function renderChips(insight) {
    const confidencePct = Math.round((insight.confidence || 0) * 100);
    const freshness = freshnessLabel(insight.freshnessDays);
    const evidenceCount = insight.evidence?.length || 0;
    const chips = [
        `Confidence: ${confidencePct}%`,
        `Freshness: ${freshness}`,
        `Evidence: ${evidenceCount}`
    ];

    const detected = insight.firstSeenAt ? formatDate(insight.firstSeenAt) : null;
    if (detected) chips.push(`Detected: ${detected}`);

    const dueDate = insight.dueDate || insight.validTo;
    if (dueDate) chips.push(`Due: ${formatDate(dueDate)}`);

    return chips.map((label) => `<span class="insight-chip">${escapeHtml(label)}</span>`).join('');
}

function renderInsightCard(insight, options = {}) {
    const includeExplain = options.includeExplain !== false;
    const formatActionLabel = (value = 'Open') => {
        const raw = String(value || 'Open').replace(/\s+/g, ' ').trim();
        if (!raw) return 'Open';
        return raw.length > 42 ? `${raw.slice(0, 41)}…` : raw;
    };

    return `
        <article class="insight-card" data-insight-id="${escapeHtml(insight.id)}">
            <div class="insight-card-top">
                <div class="insight-card-title">${escapeHtml(insight.title)}</div>
                <div class="insight-chip-row">${renderChips(insight)}</div>
            </div>
            <div class="insight-card-summary">${escapeHtml(insight.summary)}</div>
            <div class="insight-actions">
                ${insight.action ? `<button class="insight-btn" data-action="open-item" data-insight-id="${escapeHtml(insight.id)}" data-source-section="${escapeHtml(insight.action.sourceSection)}" data-source-id="${escapeHtml(insight.action.sourceId)}" data-source-hint="${escapeHtml(truncateText(`${insight.title} ${insight.summary}`, 180))}" title="${escapeHtml(insight.action.label || 'Open')}">${escapeHtml(formatActionLabel(insight.action.label || 'Open'))}</button>` : ''}
                ${insight.secondaryAction ? `<button class="insight-btn" data-action="open-item" data-insight-id="${escapeHtml(insight.id)}" data-source-section="${escapeHtml(insight.secondaryAction.sourceSection)}" data-source-id="${escapeHtml(insight.secondaryAction.sourceId)}" data-source-hint="${escapeHtml(truncateText(`${insight.title} ${insight.summary}`, 180))}" title="${escapeHtml(insight.secondaryAction.label || 'Open Related')}">${escapeHtml(formatActionLabel(insight.secondaryAction.label || 'Open Related'))}</button>` : ''}
                ${includeExplain ? `<button class="insight-btn" data-action="open-explain" data-insight-id="${escapeHtml(insight.id)}">Explain</button>` : ''}
            </div>
        </article>
    `;
}

function renderSummaryKpis(summary = {}) {
    const cards = [
        {
            label: 'Active Deep Signals',
            value: summary.active || 0,
            note: `${summary.recent || 0} detected this week`
        },
        {
            label: 'Due Soon',
            value: summary.dueSoon || 0,
            note: 'Action windows within 14 days'
        },
        {
            label: 'Risk Signals',
            value: summary.risks || 0,
            note: 'Escalations and blockers'
        },
        {
            label: 'Insight Log',
            value: summary.logged || 0,
            note: 'Persistent cumulative history'
        }
    ];

    return `
        <div class="insight-kpi-grid">
            ${cards.map((card) => `
                <article class="insight-kpi-card">
                    <div class="insight-kpi-label">${escapeHtml(card.label)}</div>
                    <div class="insight-kpi-value">${escapeHtml(card.value)}</div>
                    <div class="insight-kpi-note">${escapeHtml(card.note)}</div>
                </article>
            `).join('')}
        </div>
    `;
}

function renderSection(key, title, subtitle, items, emptyMessage = 'No items right now.', options = {}) {
    const body = items.length
        ? items.map((insight) => renderInsightCard(insight, options)).join('')
        : `<div class="insight-empty">${escapeHtml(emptyMessage)}</div>`;

    return `
        <section class="insight-section insight-section-${escapeHtml(key)}">
            <div class="insight-section-head">
                <div class="insight-section-title">${escapeHtml(title)}</div>
                <div class="insight-section-meta" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)} · ${items.length}</div>
            </div>
            <div class="insight-section-body">${body}</div>
        </section>
    `;
}

function renderExplainPanel() {
    const insight = activeInsightId ? insightIndex.get(activeInsightId) : null;
    if (!insight) {
        return `<div class="insight-explain-panel" id="insight-explain-panel"></div>`;
    }

    const evidenceHtml = (insight.evidence || []).map((entry) => {
        const snippetHtml = parseMarkdown(entry.snippet || 'No snippet');
        const hint = truncateText(`${entry.label || ''} ${entry.snippet || ''}`, 180);
        return `
            <div class="insight-evidence-entry">
                <div class="insight-evidence-head">${escapeHtml(entry.label || 'Evidence')}</div>
                <div class="insight-evidence-meta">${escapeHtml(formatDate(entry.timestamp))}</div>
                <div class="insight-evidence-snippet markdown-content">${snippetHtml}</div>
                ${entry.sourceId ? `<button class="insight-btn" data-action="open-item" data-insight-id="${escapeHtml(insight.id)}" data-source-section="${escapeHtml(entry.sourceSection || 'People')}" data-source-id="${escapeHtml(entry.sourceId)}" data-source-hint="${escapeHtml(hint)}">Open Source</button>` : ''}
            </div>
        `;
    }).join('');

    return `
        <div class="insight-explain-panel open" id="insight-explain-panel">
            <button class="insight-explain-backdrop" data-action="close-explain" aria-label="Close"></button>
            <aside class="insight-explain-drawer">
                <div class="insight-explain-head">
                    <div class="insight-explain-title">${escapeHtml(insight.title)}</div>
                    <button class="insight-btn" data-action="close-explain">Close</button>
                </div>
                <div class="insight-explain-body markdown-content">${parseMarkdown(insight.why || 'No explanation available.')}</div>
                <div class="insight-explain-subhead">Evidence</div>
                <div class="insight-evidence-list">${evidenceHtml || '<div class="insight-empty">No evidence attached.</div>'}</div>
            </aside>
        </div>
    `;
}

function normalizeSection(value = '') {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'person' || key === 'people') return 'People';
    if (key === 'group' || key === 'groups') return 'Groups';
    if (key === 'note' || key === 'notes') return 'Notes';
    return '';
}

function buildSearchableText(section, item) {
    if (!item || typeof item !== 'object') return '';
    if (section === 'People') {
        return [
            item.firstName,
            item.lastName,
            item.nickname,
            item.notes,
            ...(Array.isArray(item.extraFields) ? item.extraFields.map((pair) => `${pair?.key || ''} ${pair?.value || ''}`) : [])
        ].join(' ').toLowerCase();
    }
    if (section === 'Groups') {
        return [item.name, item.description].join(' ').toLowerCase();
    }
    return [item.title, item.body].join(' ').toLowerCase();
}

function buildHintTokens(raw = '') {
    const seen = new Set();
    return String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .filter((token) => {
            if (seen.has(token)) return false;
            seen.add(token);
            return true;
        })
        .slice(0, 14);
}

function findBestItemId(data, section, hintText) {
    const items = Array.isArray(data?.[section]) ? data[section] : [];
    if (!items.length) return '';

    const tokens = buildHintTokens(hintText);
    if (!tokens.length) return '';

    let bestId = '';
    let bestScore = 0;

    items.forEach((item) => {
        const haystack = buildSearchableText(section, item);
        if (!haystack) return;

        let score = 0;
        tokens.forEach((token) => {
            if (haystack.includes(token)) score += token.length;
        });

        if (score > bestScore) {
            bestScore = score;
            bestId = String(item.id || '');
        }
    });

    return bestScore > 0 ? bestId : '';
}

function locateSectionForId(data, sourceId = '') {
    const rawId = String(sourceId || '').trim();
    if (!rawId) return '';

    const sections = ['People', 'Groups', 'Notes'];
    for (const section of sections) {
        const items = Array.isArray(data?.[section]) ? data[section] : [];
        if (items.some((item) => String(item?.id || '') === rawId)) {
            return section;
        }
    }
    return '';
}

function openSourceItem(sourceSection, sourceId, insightId = '', sourceHint = '') {
    const data = getStoredData();
    if (!data || typeof data !== 'object') return;

    let targetSection = normalizeSection(sourceSection) || 'People';
    let resolvedId = '';
    const sourceIdText = String(sourceId || '').trim();

    if (sourceIdText) {
        const items = Array.isArray(data[targetSection]) ? data[targetSection] : [];
        if (items.some((item) => String(item?.id || '') === sourceIdText)) {
            resolvedId = sourceIdText;
        } else {
            const crossSection = locateSectionForId(data, sourceIdText);
            if (crossSection) {
                targetSection = crossSection;
                resolvedId = sourceIdText;
            }
        }
    }

    const insight = insightId ? insightIndex.get(insightId) : null;
    const hintText = [
        sourceHint,
        insight?.title || '',
        insight?.summary || '',
        ...(Array.isArray(insight?.evidence) ? insight.evidence.map((entry) => `${entry?.label || ''} ${entry?.snippet || ''}`) : [])
    ].join(' ');

    if (!resolvedId) {
        resolvedId = findBestItemId(data, targetSection, hintText);
    }

    if (!resolvedId) {
        ['People', 'Groups', 'Notes'].some((section) => {
            const candidateId = findBestItemId(data, section, hintText);
            if (!candidateId) return false;
            targetSection = section;
            resolvedId = candidateId;
            return true;
        });
    }

    const notesIcon = document.querySelector('.sidebar-icon[data-page="notes-page"]');
    if (window.loadPage) window.loadPage('notes-page', notesIcon);

    if (window.switchSection) {
        const tab = Array.from(document.querySelectorAll('.tab-btn')).find((btn) => btn.innerText.trim() === targetSection);
        window.switchSection(targetSection, tab);
    }

    if (resolvedId && window.loadItemIntoEditor) {
        const loaded = window.loadItemIntoEditor(resolvedId);
        if (loaded !== false) return;
    }

    const searchSeed = buildHintTokens(hintText).slice(0, 4).join(' ');
    const searchInput = document.getElementById('search-input');
    if (searchInput && searchSeed) {
        searchInput.value = searchSeed;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

function bindInsightInteractions(container, options = {}) {
    const allowExplain = options.allowExplain !== false;

    container.onclick = (event) => {
        const trigger = event.target.closest('[data-action]');
        if (!trigger) return;

        const action = trigger.dataset.action;

        if (action === 'open-item') {
            openSourceItem(
                trigger.dataset.sourceSection,
                trigger.dataset.sourceId,
                trigger.dataset.insightId,
                trigger.dataset.sourceHint
            );
            return;
        }

        if (action === 'open-explain') {
            if (!allowExplain) return;
            activeInsightId = trigger.dataset.insightId || null;
            renderInsights();
            return;
        }

        if (action === 'close-explain') {
            if (!allowExplain) return;
            activeInsightId = null;
            renderInsights();
        }
    };
}

function buildToplineMeta(logState) {
    if (runtimeState.loading) return 'Scanning for new deep signals...';
    if (runtimeState.error) return `Last scan issue: ${runtimeState.error}`;

    const source = runtimeState.source || 'memory-bank deep scan';
    const lastScan = runtimeState.lastScanAt || logState.lastScanAt;
    if (lastScan) return `Last scan ${formatDate(lastScan)} · ${source}`;
    return source;
}

function renderInsightsMarkup(model, logState, options = {}) {
    const { sections, generatedAt, summary } = model;
    const includeExplain = options.includeExplain !== false;
    const embedded = !!options.embedded;
    const title = options.title || 'Actionable Intelligence';

    return `
        <div class="insight-topline ${embedded ? 'insight-topline-embedded' : ''}">
            <div class="insight-topline-title">${escapeHtml(title)}</div>
            <div class="insight-topline-meta">${escapeHtml(buildToplineMeta(logState))}</div>
        </div>

        ${renderSummaryKpis(summary)}

        <div class="insight-sections-grid ${embedded ? 'insight-sections-grid-embedded' : ''}">
            ${renderSection('next', 'Next Actions', 'Due now to 48h', sections.next, 'No immediate actions.', { includeExplain })}
            ${renderSection('upcoming', 'Coming Up', '3 to 14 day windows', sections.upcoming, 'No upcoming windows.', { includeExplain })}
            ${renderSection('risks', 'Risks', 'Conflicts, blockers, or drift', sections.risks, 'No active risk signals.', { includeExplain })}
            ${renderSection('strategic', 'Strategic Signals', 'Deeper multi-record insights', sections.strategic, 'No strategic signals right now.', { includeExplain })}
            ${renderSection('log', 'Insight Log', `Persistent history · generated ${formatDate(generatedAt)}`, sections.log, 'Insight log is empty.', { includeExplain })}
        </div>

        ${includeExplain ? renderExplainPanel() : ''}
    `;
}

async function renderInsightsContainer(container, options = {}) {
    if (!container) return;

    const data = getStoredData();
    runtimeState.loading = true;
    runtimeState.error = '';

    const loadingState = {
        entries: [],
        lastScanAt: runtimeState.lastScanAt || ''
    };
    const loadingModel = buildInsightsModel(loadingState, options);
    insightIndex = new Map();
    container.innerHTML = renderInsightsMarkup(loadingModel, loadingState, options);
    bindInsightInteractions(container, { allowExplain: options.includeExplain !== false });

    let pipelineState = {
        entries: [],
        source: '',
        error: '',
        lastScanAt: ''
    };

    try {
        pipelineState = await fetchPipelineInsights(data, {
            includeDeep: options.includeDeep !== false,
            forceScan: !!options.forceScan
        });
    } catch (error) {
        runtimeState.error = error?.message || 'Insight pipeline failed';
        pipelineState = {
            entries: [],
            source: '',
            error: runtimeState.error,
            lastScanAt: runtimeState.lastScanAt || ''
        };
    }

    runtimeState.source = pipelineState.source || runtimeState.source;
    runtimeState.lastScanAt = pipelineState.lastScanAt || runtimeState.lastScanAt;
    runtimeState.error = pipelineState.error || '';

    const latestState = {
        entries: Array.isArray(pipelineState.entries) ? pipelineState.entries : [],
        lastScanAt: pipelineState.lastScanAt || ''
    };
    const model = buildInsightsModel(latestState, options);

    insightIndex = new Map();
    Object.values(model.sections).flat().forEach((insight) => insightIndex.set(insight.id, insight));
    if (activeInsightId && !insightIndex.has(activeInsightId)) activeInsightId = null;

    container.innerHTML = renderInsightsMarkup(model, latestState, options);
    bindInsightInteractions(container, { allowExplain: options.includeExplain !== false });
}

export async function renderInsights() {
    const container = document.getElementById('insights-content');
    if (!container) return;
    return renderInsightsContainer(container, {
        includeExplain: true,
        embedded: false,
        includeDeep: true,
        title: 'Actionable Intelligence'
    });
}

export async function renderInsightsEmbed(containerOrId, options = {}) {
    const container = typeof containerOrId === 'string'
        ? document.getElementById(containerOrId)
        : containerOrId;
    if (!container) return;

    return renderInsightsContainer(container, {
        includeExplain: false,
        embedded: true,
        includeDeep: true,
        title: options.title || 'Graph Intelligence'
    });
}
