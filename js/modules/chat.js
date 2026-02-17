import { sanitizeHtml } from '../core/utils.js';
import { appSettings } from '../core/store.js';

let chatInitialized = false;

const TASK_LABELS = {
    idle: 'Idle',
    recalling_memories: 'Recalling memories',
    reflecting: 'Reflecting',
    generating_response: 'Generating response',
    storing_memory: 'Storing memory',
    complete: 'Complete',
    error: 'Error'
};

const parseMarkdown = (text) => {
    const html = (typeof marked !== 'undefined') ? marked.parse(text) : text.replace(/\n/g, '<br>');
    return sanitizeHtml(html);
};

function escapeHtml(value = '') {
    return value
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function cleanHindsightText(raw = '') {
    return String(raw || '')
        .replace(/\s*\|\s*(when|involving)\s*:[^|\n]*/gi, '')
        .replace(/^\s*(when|involving)\s*:[^\n]*\n?/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function setAgentTask(task = 'idle', detail = '') {
    const taskLabelEl = document.getElementById('agent-task-text');
    const taskDetailEl = document.getElementById('agent-task-detail');
    if (!taskLabelEl || !taskDetailEl) return;

    const label = TASK_LABELS[task] || task.replace(/_/g, ' ');
    taskLabelEl.textContent = label;
    taskDetailEl.textContent = detail || '';
}

function renderHindsightOutput(items = []) {
    const panel = document.getElementById('hindsight-output-panel');
    if (!panel) return;

    if (!Array.isArray(items) || !items.length) {
        panel.classList.add('empty');
        panel.innerHTML = '<div class="hindsight-empty">No recovered context returned for this query.</div>';
        return;
    }

    panel.classList.remove('empty');
    panel.innerHTML = items
        .slice(0, 8)
        .map((item, index) => {
            const title = item.title || item.type || `Memory ${index + 1}`;
            const text = cleanHindsightText(item.text || item.snippet || '');
            const renderedText = parseMarkdown(text || 'No text');
            const metaParts = [];
            if (item.context) metaParts.push(item.context);
            if (item.timestamp) metaParts.push(item.timestamp.slice(0, 10));
            if (Array.isArray(item.tags) && item.tags.length) metaParts.push(item.tags.join(', '));
            return `
                <div class="hindsight-output-item">
                    <div class="hindsight-output-title">${escapeHtml(title)}</div>
                    <div class="hindsight-output-text">${renderedText}</div>
                    <div class="hindsight-output-meta">${escapeHtml(metaParts.join(' · ') || 'No metadata')}</div>
                </div>
            `;
        })
        .join('');
}

function getBudgetLabel(value) {
    if (value === 'low') return 'LOW';
    if (value === 'high') return 'HIGH';
    return 'DEFAULT';
}

function applyAgentConfigUI() {
    const budgetEl = document.getElementById('agent-budget-text');
    if (budgetEl) budgetEl.textContent = getBudgetLabel(appSettings.reasoningBudget);

    const budgetPicker = document.getElementById('reasoning-budget-picker');
    if (budgetPicker) budgetPicker.value = appSettings.reasoningBudget || 'mid';

    const reflectToggle = document.getElementById('agent-reflect-toggle');
    if (reflectToggle) reflectToggle.checked = !!appSettings.agentUseReflect;

    const reflectStateEl = document.getElementById('agent-reflect-state');
    if (reflectStateEl) reflectStateEl.textContent = appSettings.agentUseReflect ? 'Enabled' : 'Disabled';

    const memorySaveToggle = document.getElementById('agent-memory-save-toggle');
    if (memorySaveToggle) memorySaveToggle.checked = appSettings.agentSaveConversation !== false;

    const memorySaveStateEl = document.getElementById('agent-memory-save-state');
    if (memorySaveStateEl) memorySaveStateEl.textContent = (appSettings.agentSaveConversation !== false) ? 'Enabled' : 'Disabled';
}

export function initLLMPage() {
    const container = document.getElementById('llm-page');
    if (!container) return;

    if (chatInitialized) {
        applyAgentConfigUI();
        return;
    }

    container.innerHTML = `
        <div id="agent-console">
            <div class="agent-console-head">
                <div class="agent-console-title">Agent Runtime</div>
                <div class="agent-console-budget">Budget <span id="agent-budget-text">DEFAULT</span></div>
            </div>
            <div class="agent-console-controls">
                <label class="agent-control">
                    <span class="agent-task-label">Reasoning Budget</span>
                    <select id="reasoning-budget-picker" class="agent-inline-select" onchange="updateReasoningBudget(this.value)">
                        <option value="low">Low</option>
                        <option value="mid">Default</option>
                        <option value="high">High</option>
                    </select>
                </label>
                <div class="agent-control agent-control-toggle">
                    <span class="agent-task-label">Use Reflect Mode</span>
                    <div class="agent-toggle-shell">
                        <label class="toggle-switch">
                            <input type="checkbox" id="agent-reflect-toggle" onchange="toggleAgentReflect(this.checked)">
                            <span class="slider"></span>
                        </label>
                        <span id="agent-reflect-state" class="agent-toggle-state">Disabled</span>
                    </div>
                </div>
                <div class="agent-control agent-control-toggle">
                    <span class="agent-task-label">Save Conversation to Memory</span>
                    <div class="agent-toggle-shell">
                        <label class="toggle-switch">
                            <input type="checkbox" id="agent-memory-save-toggle" onchange="toggleAgentMemorySave(this.checked)">
                            <span class="slider"></span>
                        </label>
                        <span id="agent-memory-save-state" class="agent-toggle-state">Enabled</span>
                    </div>
                </div>
            </div>
            <div class="agent-console-task">
                <span class="agent-task-label">Current Task</span>
                <span id="agent-task-text">Idle</span>
                <span id="agent-task-detail"></span>
            </div>
            <div class="agent-console-subhead">Recovered Context</div>
            <div id="hindsight-output-panel" class="hindsight-output-panel empty"></div>
        </div>

        <div id="chat-history">
            <div class="chat-message msg-ai">
                Everything is prepared. Tell me what you need, and I will assemble the clearest path forward.
            </div>
        </div>

        <div id="chat-input-area">
            <input type="text" id="chat-input" placeholder="ENTER COMMAND OR QUERY...">

            <div id="send-btn" class="icon-btn" title="Send">
                <span class="material-symbols-outlined">send</span>
            </div>
        </div>
    `;

    const input = document.getElementById('chat-input');
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleChatSubmit();
    });

    document.getElementById('send-btn').addEventListener('click', handleChatSubmit);

    chatInitialized = true;
    applyAgentConfigUI();
    setAgentTask('idle', 'Waiting for query');
    renderHindsightOutput([]);
}

async function handleChatSubmit() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    addMessage(text, 'user');

    const history = document.getElementById('chat-history');

    const aiMsgId = `msg-${Date.now()}`;
    const aiMsgEl = document.createElement('div');
    aiMsgEl.className = 'chat-message msg-ai';
    aiMsgEl.id = aiMsgId;
    aiMsgEl.innerHTML = '<span class="typing-indicator">...</span>';
    history.appendChild(aiMsgEl);
    history.scrollTop = history.scrollHeight;

    let fullResponseText = '';
    let isFirstChunk = true;
    let sawError = false;

    applyAgentConfigUI();
    renderHindsightOutput([]);
    setAgentTask('recalling_memories', 'Scanning memory bank');

    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                reasoning_budget: appSettings.reasoningBudget || 'mid',
                use_reflect: !!appSettings.agentUseReflect,
                persist_memory: appSettings.agentSaveConversation !== false
            })
        });

        if (!response.ok || !response.body) {
            throw new Error(`Chat request failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;

                try {
                    const data = JSON.parse(line);
                    const currentBubble = document.getElementById(aiMsgId);

                    if (data.type === 'task') {
                        setAgentTask(data.task || 'idle', data.detail || '');
                        continue;
                    }

                    if (data.type === 'status') {
                        setAgentTask(data.task || 'idle', data.content || '');
                        continue;
                    }

                    if (data.type === 'hindsight_output') {
                        renderHindsightOutput(data.content || []);
                        continue;
                    }

                    if (data.type === 'error') {
                        sawError = true;
                        if (currentBubble) currentBubble.innerText = `Error: ${data.content || 'Unknown error'}`;
                        setAgentTask('error', data.content || 'Unknown error');
                        continue;
                    }

                    if (data.type === 'result') {
                        if (isFirstChunk) {
                            if (currentBubble) currentBubble.innerHTML = '';
                            isFirstChunk = false;
                        }

                        fullResponseText += data.content || '';
                        if (currentBubble) currentBubble.innerHTML = parseMarkdown(fullResponseText);
                        history.scrollTop = history.scrollHeight;
                    }
                } catch {
                    // Ignore malformed stream chunks and continue.
                }
            }
        }

        if (!sawError && !fullResponseText.trim()) {
            const currentBubble = document.getElementById(aiMsgId);
            if (currentBubble) currentBubble.innerText = 'No response generated.';
        }

        if (!sawError) {
            setAgentTask('complete', 'Done');
        }
    } catch (e) {
        const currentBubble = document.getElementById(aiMsgId);
        if (currentBubble) currentBubble.innerText = `Connection failure: ${e.message}`;
        setAgentTask('error', e.message);
    }
}

function addMessage(text, sender) {
    const history = document.getElementById('chat-history');
    if (!history) return;

    const msg = document.createElement('div');
    msg.className = `chat-message msg-${sender}`;
    msg.innerHTML = parseMarkdown(text);

    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
}
