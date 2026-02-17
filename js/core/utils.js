// Populates the 3 input fields from a YYYY-MM-DD string
export function setDateInputs(monthId, dayId, yearId, dateString) {
    if (!dateString) {
        const mEl = document.getElementById(monthId);
        const dEl = document.getElementById(dayId);
        const yEl = document.getElementById(yearId);
        if(mEl) mEl.value = "";
        if(dEl) dEl.value = "";
        if(yEl) yEl.value = "";
        return;
    }
    const [y, m, d] = dateString.split('-');
    
    const mEl = document.getElementById(monthId);
    const dEl = document.getElementById(dayId);
    const yEl = document.getElementById(yearId);

    if(mEl) mEl.value = m || "";
    if(dEl) dEl.value = parseInt(d) || ""; 
    if(yEl) yEl.value = (y === "0000") ? "" : y;
}

// Combines the 3 input fields into a YYYY-MM-DD string
export function getDateString(monthId, dayId, yearId) {
    const mEl = document.getElementById(monthId);
    const dEl = document.getElementById(dayId);
    const yEl = document.getElementById(yearId);

    if (!mEl || !dEl) return "";

    const m = mEl.value;
    const d = dEl.value;
    const y = yEl ? yEl.value : "";

    if (!m || !d) return ""; 
    
    // Strict Year Validation
    let safeYear = "0000";
    if (y) {
        const yearNum = parseInt(y);
        const currentYear = new Date().getFullYear();
        // If year is reasonable (between 1900 and next year), use it.
        // Otherwise default to 0000 (meaning year unknown/ignored)
        if(yearNum > 1900 && yearNum <= currentYear + 1) {
            safeYear = y.padStart(4, '0');
        }
    }

    const pad = (n) => n.toString().padStart(2, '0');
    return `${safeYear}-${pad(m)}-${pad(d)}`;
}

// Basic sanitization layer for rendered HTML content.
export function sanitizeHtml(rawHtml = '') {
    if (!rawHtml || typeof rawHtml !== 'string') return '';

    const template = document.createElement('template');
    template.innerHTML = rawHtml;

    template.content.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((node) => {
        node.remove();
    });

    template.content.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            const value = (attr.value || '').trim().toLowerCase();

            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
                return;
            }

            if ((name === 'href' || name === 'src') && value.startsWith('javascript:')) {
                el.removeAttribute(attr.name);
            }
        });
    });

    return template.innerHTML;
}
