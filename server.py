import os
import json
import httpx
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional, Iterator
from dotenv import load_dotenv

# --- IMPORTS FOR HINDSIGHT ---
from openai import OpenAI
from hindsight_litellm import wrap_openai

# --- 0. CONFIGURATION ---
load_dotenv()

# Use 127.0.0.1 to avoid localhost IPv6 resolution issues
HINDSIGHT_URL = os.getenv("HINDSIGHT_API_URL", "http://127.0.0.1:8888")
BANK_ID = "personal-crm"
MODEL_NAME = os.getenv("LLM_MODEL", "gpt-4o")

# --- 1. GLOBAL STATE ---
http_client: Optional[httpx.AsyncClient] = None
sessions: Dict[str, List[dict]] = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    # Initialize persistent HTTP client for the proxy
    http_client = httpx.AsyncClient(timeout=60.0)
    print(f"--- SYSTEM ONLINE: Hindsight Wrapper Active ({HINDSIGHT_URL}) ---")
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

# Get the absolute path to the folder where server.py is located
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Mount using paths relative to this script, not the terminal command
app.mount("/js", StaticFiles(directory=os.path.join(BASE_DIR, "js")), name="js")
app.mount("/css", StaticFiles(directory=os.path.join(BASE_DIR, "css")), name="css")

# --- 3. WRAPPER LOGIC ---
def get_hindsight_client():
    """
    Wraps the standard OpenAI client with Hindsight.
    Automatically handles memory injection and retention.
    """
    return wrap_openai(
        OpenAI(api_key=os.getenv("OPENAI_API_KEY")),
        bank_id=BANK_ID,
        hindsight_api_url=HINDSIGHT_URL,
        store_conversations=False, # We manage history manually below
        verbose=True  # Keep True for debugging memory injection
    )

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"

# --- 4. ROUTES ---

@app.get("/")
async def read_index():
    return FileResponse("index.html")

@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    async def event_generator() -> Iterator[str]:
        # A. Initialize Wrapped Client
        try:
            client = get_hindsight_client()
        except Exception as e:
            yield json.dumps({"type": "error", "content": f"Client Init Error: {str(e)}"}) + "\n"
            return

        # B. Manage Session History
        if req.session_id not in sessions:
            sessions[req.session_id] = [{"role": "system", "content": "You are a helpful assistant."}]
        
        history = sessions[req.session_id]
        history.append({"role": "user", "content": req.message})
        
        # Keep context window manageable (last 20 messages)
        if len(history) > 20: 
            history = history[-20:]
            if history[0]["role"] != "system":
                history.insert(0, {"role": "system", "content": "You are a helpful assistant."})

        try:
            # C. Generate Response (Intercepted by Hindsight)
            # The wrapper injects relevant memories into 'messages' before sending to OpenAI
            response = client.chat.completions.create(
                model=MODEL_NAME,
                messages=history,
                stream=True,
            )
            
            full_answer = ""
            for chunk in response:
                if chunk.choices and chunk.choices[0].delta.content:
                    text = chunk.choices[0].delta.content
                    full_answer += text
                    yield json.dumps({"type": "result", "content": text}) + "\n"
            
            # Update history
            history.append({"role": "assistant", "content": full_answer})
            sessions[req.session_id] = history
            
        except Exception as e:
            print(f"Chat Error: {e}")
            yield json.dumps({"type": "error", "content": str(e)}) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

# --- 5. HINDSIGHT PROXY (Required for Graph UI) ---
@app.api_route("/v1/{path:path}", methods=["GET", "POST", "DELETE", "PUT"])
async def proxy_to_hindsight(path: str, request: Request):
    global http_client
    url = f"{HINDSIGHT_URL}/v1/{path}"
    
    try:
        body = await request.body()
        # Forward headers but exclude host/length to avoid conflicts
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