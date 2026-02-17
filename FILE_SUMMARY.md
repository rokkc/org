# Organizer CRM: File Summary

This document summarizes what each project-maintained file does.

## Root files

### `/Users/yash/Desktop/org/index.html`
- Defines the full single-page app shell.
- Contains page sections for Notes, Graph, LLM Chat, Insights, and Settings.
- Wires UI actions through inline handlers (for example `loadPage`, `switchSection`, `handleSave`).
- Loads external UI libraries (`Quill`, `marked`, `d3`) and starts the app via `js/app.js`.

### `/Users/yash/Desktop/org/server.py`
- Runs the FastAPI backend.
- Serves static frontend assets (`index.html`, `/js`, `/css`).
- Exposes `POST /chat` for streamed LLM responses.
- Wraps OpenAI calls with Hindsight (`wrap_openai`) to inject/store memory context.
- Proxies `/v1/*` requests to the Hindsight API so the frontend graph features can call Hindsight through this server.

### `/Users/yash/Desktop/org/.env`
- Local environment configuration for runtime secrets and endpoints.
- Includes keys used by the backend such as `OPENAI_API_KEY`, `HINDSIGHT_API_URL`, `HINDSIGHT_BANK_ID`, and `LLM_MODEL`.
- Not intended for source control.

### `/Users/yash/Desktop/org/.gitignore`
- Excludes local/runtime artifacts from git:
  - `venv/`
  - `__pycache__/`
  - `.env`
  - `.DS_Store`
  - `node_modules/`

## Frontend styles

### `/Users/yash/Desktop/org/css/styles.css`
- Defines the complete visual system for the app (dark detective-style theme, spacing, typography, controls).
- Styles the core CRM editor/list UI, Quill editor areas, settings cards, insights widgets, graph/timeline/table views, and chat interface.
- Includes behavior-linked classes used by JS (for example blur mode, active state classes, graph highlight/dim classes).

## Frontend app code

### `/Users/yash/Desktop/org/js/app.js`
- Main frontend controller and state manager.
- Handles:
  - section/page navigation
  - list rendering/filter/sort
  - editor field generation by section (`People`, `Groups`, `Items`, `General`, `Me`)
  - create/save/delete CRUD flows in localStorage
  - settings toggles and appearance updates
  - profile ("Me") save/load
  - Hindsight memory sync/delete calls for People/Groups

### `/Users/yash/Desktop/org/js/core/store.js`
- Central local storage + settings module.
- Defines default app settings, loads/saves settings, applies appearance variables/classes, and reads/writes CRM data payloads.

### `/Users/yash/Desktop/org/js/core/utils.js`
- Utility helpers for date field handling.
- Converts stored date strings into split inputs and rebuilds validated date strings from UI inputs.

### `/Users/yash/Desktop/org/js/modules/editor.js`
- Initializes Quill editors (main notes editor + "Me" profile editor).
- Implements mention popup behavior triggered by `@`.
- Pulls People names from stored data and inserts formatted mentions into editor content.

### `/Users/yash/Desktop/org/js/modules/chat.js`
- Builds and initializes the LLM chat UI lazily when chat page opens.
- Sends prompts to backend `/chat`.
- Consumes newline-delimited streaming response chunks.
- Renders progressively streamed markdown replies into the chat history.

### `/Users/yash/Desktop/org/js/modules/insights.js`
- Computes lightweight CRM insights from People data:
  - upcoming birthdays
  - stale contacts (90+ days since last contact)
- Renders clickable insight cards that open related records.

### `/Users/yash/Desktop/org/js/modules/graph.js`
- Controls Graph page initialization and mode switching (`Network`, `Table`, `Timeline`).
- Pulls graph data from Hindsight via `hindsight.getGraph()`.
- Processes nodes/edges for rendering, handles entity filtering/highlighting, and manages detail panel interactions.
- Uses D3 force simulation for interactive network rendering and drag behavior.
- Supports deleting memory nodes through Hindsight.

### `/Users/yash/Desktop/org/js/services/hindsight.js`
- Thin frontend service wrapper for Hindsight API calls.
- Provides methods to:
  - create/update memories (`syncDocument`)
  - delete memory documents
  - fetch graph data
  - wipe entire bank (`clearBank`)

## Local virtual environment

### `/Users/yash/Desktop/org/venv/pyvenv.cfg`
- Python virtual environment metadata (interpreter path/version used to create the venv).

### `/Users/yash/Desktop/org/venv/.gitignore`
- Ensures files inside the virtual environment directory are ignored in nested git contexts.

### `/Users/yash/Desktop/org/venv/*`
- Installed dependency artifacts for local execution.
- Generated/runtime files; not project source code.
