// Default configuration
export const defaultSettings = {
    accent: '#00bcd4',
    uiDensity: 'default',
    graphSpacing: 100,
    blurMode: false,
    reasoningBudget: 'mid',
    agentUseReflect: false,
    agentSaveConversation: true
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
            if (!parsed.uiDensity && parsed.fontSize) {
                if (parsed.fontSize === '12px') parsed.uiDensity = 'compact';
                else if (parsed.fontSize === '16px') parsed.uiDensity = 'spacious';
                else parsed.uiDensity = 'default';
            }

            appSettings = { ...defaultSettings, ...parsed };
        } catch(e) {
            console.warn("Settings parse error, using defaults");
        }
    }

    if (!['compact', 'default', 'spacious'].includes(appSettings.uiDensity)) {
        appSettings.uiDensity = defaultSettings.uiDensity;
    }
    if (typeof appSettings.graphSpacing === 'string') {
        const legacySpacingMap = {
            tight: 80,
            default: 100,
            loose: 145
        };
        appSettings.graphSpacing = legacySpacingMap[appSettings.graphSpacing] || defaultSettings.graphSpacing;
    }
    const graphSpacing = Number(appSettings.graphSpacing);
    appSettings.graphSpacing = Number.isFinite(graphSpacing)
        ? Math.min(260, Math.max(40, Math.round(graphSpacing)))
        : defaultSettings.graphSpacing;
    if (!['low', 'mid', 'high'].includes(appSettings.reasoningBudget)) {
        appSettings.reasoningBudget = defaultSettings.reasoningBudget;
    }
    appSettings.agentUseReflect = !!appSettings.agentUseReflect;
    appSettings.agentSaveConversation = appSettings.agentSaveConversation !== false;

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
    const densityMap = {
        compact: { font: '13px', scale: 0.9 },
        default: { font: '14px', scale: 1 },
        spacious: { font: '15px', scale: 1.12 }
    };
    const density = densityMap[appSettings.uiDensity] || densityMap.default;

    document.documentElement.style.setProperty('--accent', appSettings.accent);
    document.documentElement.style.setProperty('--base-font-size', density.font);
    document.documentElement.style.setProperty('--density-scale', String(density.scale));

    if(appSettings.blurMode) document.body.classList.add('blur-mode');
    else document.body.classList.remove('blur-mode');

    const densityPick = document.getElementById('ui-density-picker');
    if (densityPick) densityPick.value = appSettings.uiDensity;

    const graphSpacingSlider = document.getElementById('graph-spacing-slider');
    if (graphSpacingSlider) graphSpacingSlider.value = String(appSettings.graphSpacing);
    const graphSpacingValue = document.getElementById('graph-spacing-value');
    if (graphSpacingValue) graphSpacingValue.textContent = `${appSettings.graphSpacing}%`;

    const blurTog = document.getElementById('blur-toggle');
    if(blurTog) blurTog.checked = appSettings.blurMode;

    const reasoningPick = document.getElementById('reasoning-budget-picker');
    if (reasoningPick) reasoningPick.value = appSettings.reasoningBudget;
    const runtimeBudget = document.getElementById('agent-budget-text');
    if (runtimeBudget) {
        runtimeBudget.textContent = appSettings.reasoningBudget === 'high'
            ? 'HIGH'
            : (appSettings.reasoningBudget === 'low' ? 'LOW' : 'DEFAULT');
    }

    const agentReflectToggle = document.getElementById('agent-reflect-toggle');
    if (agentReflectToggle) {
        agentReflectToggle.checked = !!appSettings.agentUseReflect;
    }
    const reflectStateText = document.getElementById('agent-reflect-state');
    if (reflectStateText) {
        reflectStateText.textContent = appSettings.agentUseReflect ? 'Enabled' : 'Disabled';
    }

    const saveConversationToggle = document.getElementById('agent-memory-save-toggle');
    if (saveConversationToggle) {
        saveConversationToggle.checked = !!appSettings.agentSaveConversation;
    }
    const saveConversationState = document.getElementById('agent-memory-save-state');
    if (saveConversationState) {
        saveConversationState.textContent = appSettings.agentSaveConversation ? 'Enabled' : 'Disabled';
    }
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
