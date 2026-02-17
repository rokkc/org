// Default configuration
export const defaultSettings = {
    accent: '#EAEAEA',
    fontSize: '14px',
    sortOrder: 'recent',
    blurMode: false
};

// Mutable settings object
export let appSettings = { ...defaultSettings };

const LEGACY_EXTRA_FIELD_MAPPINGS = [
    { source: 'phone', label: 'Phone' },
    { source: 'linkedin', label: 'LinkedIn' },
    { source: 'instagram', label: 'Instagram' },
    { source: 'twitter', label: 'X' },
    { source: 'discord', label: 'Discord' }
];

function createDefaultData() {
    return { People: [], Groups: [], Notes: [] };
}

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function normalizeExtraFields(extraFields, legacySource = {}) {
    const normalized = [];
    const seen = new Set();

    const add = (key, value) => {
        const k = (key || '').toString().trim();
        const v = (value || '').toString().trim();
        if (!k || !v) return;

        const dedupeKey = k.toLowerCase();
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        normalized.push({ key: k, value: v });
    };

    toArray(extraFields).forEach((pair) => {
        if (!pair || typeof pair !== 'object') return;
        add(pair.key, pair.value);
    });

    LEGACY_EXTRA_FIELD_MAPPINGS.forEach(({ source, label }) => {
        add(label, legacySource[source]);
    });

    return normalized;
}

function normalizePerson(person, fallbackId) {
    const safe = person && typeof person === 'object' ? person : {};
    return {
        ...safe,
        id: (safe.id || fallbackId).toString(),
        firstName: (safe.firstName || '').toString(),
        lastName: (safe.lastName || '').toString(),
        nickname: (safe.nickname || '').toString(),
        birthday: (safe.birthday || '').toString(),
        notes: safe.notes || '',
        lastContacted: safe.lastContacted || '',
        extraFields: normalizeExtraFields(safe.extraFields, safe)
    };
}

function normalizeGroup(group, fallbackId) {
    const safe = group && typeof group === 'object' ? group : {};
    return {
        ...safe,
        id: (safe.id || fallbackId).toString(),
        name: (safe.name || '').toString(),
        description: safe.description || '',
        members: toArray(safe.members).map((m) => m.toString())
    };
}

function normalizeNote(note, fallbackId) {
    const safe = note && typeof note === 'object' ? note : {};
    const fallbackTitle = safe.name || safe.label || "Untitled Note";
    const fallbackBody = safe.body || safe.details || safe.description || safe.notes || "";
    return {
        ...safe,
        id: (safe.id || fallbackId).toString(),
        title: safe.title || fallbackTitle,
        body: safe.body || fallbackBody
    };
}

function migrateStoredData(parsed) {
    const safe = parsed && typeof parsed === 'object' ? parsed : {};
    const notes = [];
    const seenNotes = new Set();

    const addNoteBatch = (items, prefix) => {
        toArray(items).forEach((item, index) => {
            const normalized = normalizeNote(item, `${prefix}-${index}`);
            const key = normalized.id || `${normalized.title}-${index}`;
            if (seenNotes.has(key)) return;
            seenNotes.add(key);
            notes.push(normalized);
        });
    };

    addNoteBatch(safe.Notes, "note");
    addNoteBatch(safe.General, "general");
    addNoteBatch(safe.Items, "item");

    const migrated = {
        People: toArray(safe.People).map((person, index) => normalizePerson(person, `person-${index}`)),
        Groups: toArray(safe.Groups).map((group, index) => normalizeGroup(group, `group-${index}`)),
        Notes: notes
    };

    const didMigrate =
        !Array.isArray(safe.People) ||
        !Array.isArray(safe.Groups) ||
        !Array.isArray(safe.Notes) ||
        Array.isArray(safe.General) ||
        Array.isArray(safe.Items) ||
        toArray(safe.People).some((person) => {
            if (!person || typeof person !== 'object') return true;
            if (Array.isArray(person.extraFields)) return false;
            return LEGACY_EXTRA_FIELD_MAPPINGS.some(({ source }) => !!person[source]);
        });

    return { migrated, didMigrate };
}

// --- Settings Management ---

export function loadSettings() {
    const stored = localStorage.getItem('organizerSettings');
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            appSettings = { ...defaultSettings, ...parsed };
        } catch(e) {
            console.warn("Settings parse error, using defaults");
        }
    }

    // Accent customization is intentionally fixed.
    appSettings.accent = defaultSettings.accent;
    applyAppearance();
    return appSettings;
}

export function saveSettings(newSettings) {
    if(newSettings) appSettings = newSettings;
    appSettings.accent = defaultSettings.accent;
    localStorage.setItem('organizerSettings', JSON.stringify(appSettings));
    applyAppearance();
}

export function applyAppearance() {
    document.documentElement.style.setProperty('--accent', appSettings.accent);
    document.documentElement.style.setProperty('--base-font-size', appSettings.fontSize);

    if(appSettings.blurMode) document.body.classList.add('blur-mode');
    else document.body.classList.remove('blur-mode');

    const fontPick = document.getElementById('font-size-picker');
    if(fontPick) fontPick.value = appSettings.fontSize;

    const blurTog = document.getElementById('blur-toggle');
    if(blurTog) blurTog.checked = appSettings.blurMode;

    const sortPick = document.getElementById('sort-picker');
    if(sortPick) sortPick.value = appSettings.sortOrder;
}

// --- Data Management ---

export function getStoredData() {
    const stored = localStorage.getItem('organizerData');
    if (!stored) return createDefaultData();

    try {
        const parsed = JSON.parse(stored);
        const { migrated, didMigrate } = migrateStoredData(parsed);
        if (didMigrate) saveStoredData(migrated);
        return migrated;
    } catch(e) {
        console.warn("Data parse error, using defaults");
        return createDefaultData();
    }
}

export function saveStoredData(data) {
    localStorage.setItem('organizerData', JSON.stringify(data));
}
