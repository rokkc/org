let chatInitialized = false;

// Helper for markdown parsing (uses 'marked' library if available)
const parseMarkdown = (text) => (typeof marked !== 'undefined') ? marked.parse(text) : text.replace(/\n/g, '<br>');

export function initLLMPage() {
    const container = document.getElementById('llm-page');
    if (!container) return;
    
    // Only render once
    if (chatInitialized) return;
    
    container.innerHTML = `
        <div id="chat-history">
            <div class="chat-message msg-ai">
                System Online. Hindsight Agent active.
            </div>
        </div>
        
        <div id="chat-input-area">
            <input type="text" id="chat-input" placeholder="ENTER COMMAND OR QUERY...">
            
            <div id="send-btn" class="icon-btn" title="Send">
                <span class="material-symbols-outlined">send</span>
            </div>
        </div>
    `;

    // Wire up events
    const input = document.getElementById('chat-input');
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleChatSubmit();
    });
    
    document.getElementById('send-btn').addEventListener('click', handleChatSubmit);
    
    chatInitialized = true;
}

async function handleChatSubmit() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    addMessage(text, 'user');

    const history = document.getElementById('chat-history');
    
    // Create AI bubble with "..."
    const aiMsgId = 'msg-' + Date.now();
    const aiMsgEl = document.createElement('div');
    aiMsgEl.className = 'chat-message msg-ai';
    aiMsgEl.id = aiMsgId;
    aiMsgEl.innerHTML = '<span class="typing-indicator">...</span>'; 
    history.appendChild(aiMsgEl);
    history.scrollTop = history.scrollHeight;

    let fullResponseText = ""; 
    let isFirstChunk = true;

    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete chunk in buffer

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    const currentBubble = document.getElementById(aiMsgId);
                    
                    if (data.type === 'status') {
                        // Update status text (e.g., "Searching...")
                        if(currentBubble) currentBubble.innerHTML = `<span class="typing-indicator">${data.content}</span>`;
                    } 
                    else if (data.type === 'result') {
                        // Clear the "..." typing indicator on first text chunk
                        if (isFirstChunk) {
                            if(currentBubble) currentBubble.innerHTML = ""; 
                            isFirstChunk = false;
                        }

                        fullResponseText += data.content;
                        
                        // Render markdown
                        if(currentBubble) currentBubble.innerHTML = parseMarkdown(fullResponseText);
                        
                        // Auto-scroll to bottom
                        history.scrollTop = history.scrollHeight;
                    }
                } catch (e) { console.warn("Stream parse error", e); }
            }
        }
    } catch (e) {
        const currentBubble = document.getElementById(aiMsgId);
        if(currentBubble) currentBubble.innerText = "CONNECTION FAILURE";
    }
}

function addMessage(text, sender) {
    const history = document.getElementById('chat-history');
    if(!history) return;
    
    const msg = document.createElement('div');
    msg.className = `chat-message msg-${sender}`;
    msg.innerHTML = parseMarkdown(text);
    
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
}