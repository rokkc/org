export class HindsightBridge {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
        this.bankId = 'personal-crm';
    }

    get bankPath() {
        return `/v1/default/banks/${this.bankId}`;
    }

    async request(path, { method = 'GET', body } = {}) {
        const url = `${this.baseUrl}${path}`;

        try {
            const response = await fetch(url, {
                method,
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined
            });

            const contentType = response.headers.get('content-type') || '';
            const payload = contentType.includes('application/json')
                ? await response.json().catch(() => null)
                : await response.text().catch(() => null);

            if (!response.ok) {
                console.warn(`[Hindsight] ${method} ${path} failed`, payload || response.statusText);
                return null;
            }

            return payload;
        } catch (err) {
            console.error(`[Hindsight] ${method} ${path} error`, err);
            return null;
        }
    }

    async syncDocument(documentId, content, options = {}) {
        const {
            metadata = {},
            timestamp,
            context,
            tags,
            documentTags,
            async = false
        } = options;

        const item = {
            content,
            document_id: documentId,
            metadata
        };

        if (timestamp) item.timestamp = timestamp;
        if (context) item.context = context;
        if (Array.isArray(tags) && tags.length) item.tags = tags;

        const body = {
            items: [item],
            async
        };

        if (Array.isArray(documentTags) && documentTags.length) {
            body.document_tags = documentTags;
        }

        console.log(`[Hindsight] Syncing Doc [${documentId}]...`);
        return this.request(`${this.bankPath}/memories`, { method: 'POST', body });
    }

    async recall(query, options = {}) {
        const body = { query, ...options };
        const primary = await this.request(`${this.bankPath}/memories/recall`, { method: 'POST', body });
        if (primary !== null) return primary;
        return this.request(`${this.bankPath}/recall`, { method: 'POST', body });
    }

    async reflect(query, options = {}) {
        const body = { query, ...options };
        return this.request(`${this.bankPath}/reflect`, { method: 'POST', body });
    }

    async listOperations() {
        return this.request(`${this.bankPath}/operations`);
    }

    async deleteDocument(documentId) {
        const result = await this.request(`${this.bankPath}/documents/${documentId}`, { method: 'DELETE' });
        if (result !== null) {
            console.log(`[Hindsight] Deleted Doc [${documentId}]`);
        }
        return result;
    }

    async getGraph() {
        return this.request(`${this.bankPath}/graph`);
    }

    async clearBank() {
        console.log(`[Hindsight] Wiping Bank ${this.bankId}...`);
        const result = await this.request(`${this.bankPath}/memories`, { method: 'DELETE' });
        if (result !== null) {
            console.log('[Hindsight] Bank Wiped.');
        }
        return result;
    }
}

// Export a singleton instance to be used throughout the app
export const hindsight = new HindsightBridge();
