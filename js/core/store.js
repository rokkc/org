// Default configuration
export const defaultSettings = { 
    accent: '#EAEAEA', 
    fontSize: '14px', 
    sortOrder: 'recent', 
    blurMode: false,
    visibleFields: { linkedin: true, instagram: true, twitter: true, discord: true } 
};

// Mutable settings object
export let appSettings = { ...defaultSettings };

// --- Settings Management ---

export function loadSettings() {
    const stored = localStorage.getItem('organizerSettings');
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            // Merge defaults to ensure new fields (like visibleFields) exist
            appSettings = { ...defaultSettings, ...parsed };
            
            // specific check for nested objects like visibleFields
            if(!appSettings.visibleFields) appSettings.visibleFields = defaultSettings.visibleFields;
        } catch(e) {
            console.warn("Settings parse error, using defaults");
        }
    }
    applyAppearance();
    return appSettings;
}

export function saveSettings(newSettings) {
    if(newSettings) appSettings = newSettings;
    localStorage.setItem('organizerSettings', JSON.stringify(appSettings));
    applyAppearance();
}

export function applyAppearance() {
    // 1. CSS Variables
    document.documentElement.style.setProperty('--accent', appSettings.accent);
    document.documentElement.style.setProperty('--base-font-size', appSettings.fontSize);
    
    // 2. Body Classes
    if(appSettings.blurMode) document.body.classList.add('blur-mode');
    else document.body.classList.remove('blur-mode');
    
    // 3. Sync UI Inputs (if they exist on the current page)
    const accentPick = document.getElementById('accent-picker');
    if(accentPick) accentPick.value = appSettings.accent;

    const fontPick = document.getElementById('font-size-picker');
    if(fontPick) fontPick.value = appSettings.fontSize;

    const blurTog = document.getElementById('blur-toggle');
    if(blurTog) blurTog.checked = appSettings.blurMode;

    const sortPick = document.getElementById('sort-picker');
    if(sortPick) sortPick.value = appSettings.sortOrder;

    // 4. Sync Visibility Toggles
    if (appSettings.visibleFields) {
        const setToggle = (id, val) => {
            const el = document.getElementById(id);
            if(el) el.checked = val;
        };
        setToggle('toggle-linkedin', appSettings.visibleFields.linkedin);
        setToggle('toggle-instagram', appSettings.visibleFields.instagram);
        setToggle('toggle-x', appSettings.visibleFields.twitter);
        setToggle('toggle-discord', appSettings.visibleFields.discord);
    }
}

// --- Data Management ---

export function getStoredData() {
    const stored = localStorage.getItem('organizerData');
    return stored ? JSON.parse(stored) : { People: [], Groups: [], Items: [], General: [] };
}

export function saveStoredData(data) { 
    localStorage.setItem('organizerData', JSON.stringify(data)); 
}