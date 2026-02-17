export class HindsightBridge {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
        this.bankId = 'personal-crm'; 
    }

    async syncDocument(documentId, content, metadata = {}) {
        const url = `${this.baseUrl}/v1/default/banks/${this.bankId}/memories`;
        console.log(`[Hindsight] Syncing Doc [${documentId}]...`);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: [{ content, document_id: documentId, metadata }] })
            });
            return await response.json();
        } catch (e) { console.error("[Hindsight] Sync Error:", e); }
    }

    async deleteDocument(documentId) {
        // Try standard delete pattern
        try { 
            await fetch(`${this.baseUrl}/v1/default/banks/${this.bankId}/documents/${documentId}`, { method: 'DELETE' }); 
            console.log(`[Hindsight] Deleted Doc [${documentId}]`);
        } 
        catch (e) { console.warn("Delete failed", e); }
    }

    async getGraph() {
        try {
            const response = await fetch(`${this.baseUrl}/v1/default/banks/${this.bankId}/graph`);
            return response.ok ? await response.json() : null;
        } catch (e) { return null; }
    }

    // --- Clear Bank for Reset ---
    async clearBank() {
        console.log(`[Hindsight] Wiping Bank ${this.bankId}...`);
        try {
            await fetch(`${this.baseUrl}/v1/default/banks/${this.bankId}/memories`, { method: 'DELETE' });
            console.log("[Hindsight] Bank Wiped.");
        } catch (e) { console.error("Wipe failed", e); }
    }
}

// Export a singleton instance to be used throughout the app
export const hindsight = new HindsightBridge();