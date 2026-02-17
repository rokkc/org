import { hindsight } from './services/hindsight.js';
import { loadSettings, saveSettings, getStoredData, saveStoredData, appSettings } from './core/store.js';
import { setDateInputs, getDateString } from './core/utils.js';
import { initEditors, quill, quillMe } from './modules/editor.js';
import { initLLMPage } from './modules/chat.js';
import { renderInsights } from './modules/insights.js';
import { initGraphPage } from './modules/graph.js';

// --- State ---
let activeSection = 'People';
let currentItemId = null;
let searchQuery = '';

const PAGE_TO_ROUTE = {
    'notes-page': 'notes',
    'graph-page': 'graph',
    'llm-page': 'chat',
    'insights-page': 'insights',
    'settings-page': 'settings'
};

const ROUTE_TO_PAGE = Object.fromEntries(
    Object.entries(PAGE_TO_ROUTE).map(([pageId, route]) => [route, pageId])
);

const LEGACY_EXTRA_FIELD_MAPPINGS = [
    { source: 'phone', label: 'Phone' },
    { source: 'linkedin', label: 'LinkedIn' },
    { source: 'instagram', label: 'Instagram' },
    { source: 'twitter', label: 'X' },
    { source: 'discord', label: 'Discord' }
];

function getSidebarIcon(pageId) {
    return document.querySelector(`.sidebar-icon[data-page="${pageId}"]`);
}

function getPageFromUrl() {
    const url = new URL(window.location.href);
    const route = (url.searchParams.get('page') || 'notes').toLowerCase();
    return ROUTE_TO_PAGE[route] || 'notes-page';
}

function syncUrlToPage(pageId, replace = false) {
    const route = PAGE_TO_ROUTE[pageId] || 'notes';
    const url = new URL(window.location.href);
    if (route === 'notes') url.searchParams.delete('page');
    else url.searchParams.set('page', route);

    const method = replace ? 'replaceState' : 'pushState';
    history[method]({ pageId }, '', `${url.pathname}${url.search}${url.hash}`);
}

function normalizeExtraFields(source = {}) {
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

    const existing = Array.isArray(source.extraFields) ? source.extraFields : [];
    existing.forEach((pair) => {
        if (!pair || typeof pair !== 'object') return;
        add(pair.key, pair.value);
    });

    LEGACY_EXTRA_FIELD_MAPPINGS.forEach(({ source: key, label }) => add(label, source[key]));

    return normalized;
}

function normalizeTagList(value) {
    const input = Array.isArray(value) ? value.join(',') : String(value || '');
    const seen = new Set();
    const tags = [];

    input
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .forEach((tag) => {
            if (!seen.has(tag)) {
                seen.add(tag);
                tags.push(tag);
            }
        });

    return tags;
}

function extractHashtags(value = '') {
    const matches = String(value).match(/#([a-zA-Z0-9_-]{2,40})/g) || [];
    return normalizeTagList(matches.map((entry) => entry.slice(1)));
}

function cleanTagValues(values = []) {
    const out = [];
    const seen = new Set();

    values.forEach((value) => {
        const tag = String(value || '').trim().toLowerCase();
        if (!tag) return;
        if (['none', 'null', 'n/a', 'unknown', 'undefined'].includes(tag)) return;
        if (seen.has(tag)) return;
        seen.add(tag);
        out.push(tag);
    });

    return out;
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function syncKeyValueFieldRemoveButtons(containerEl) {
    if (!containerEl) return;
    const rows = containerEl.querySelectorAll('.kv-row');
    const hideRemove = rows.length <= 1;

    rows.forEach((row) => {
        const btn = row.querySelector('.kv-remove-btn');
        if (!btn) return;
        row.style.gridTemplateColumns = hideRemove ? '1fr 1fr' : '1fr 1fr auto';
        btn.style.display = hideRemove ? 'none' : 'flex';
        btn.setAttribute('aria-hidden', hideRemove ? 'true' : 'false');
        btn.tabIndex = hideRemove ? -1 : 0;
    });
}

function addKeyValueFieldInternal(containerId, key = '', value = '') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'kv-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'clean-input kv-key';
    keyInput.placeholder = 'Field';
    keyInput.value = key;

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'clean-input kv-value';
    valueInput.placeholder = 'Value';
    valueInput.value = value;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'kv-remove-btn';
    removeBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px">close</span>';
    removeBtn.onclick = () => window.removeKeyValueField(removeBtn);

    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
    syncKeyValueFieldRemoveButtons(container);
}

function renderKeyValueFields(containerId, pairs = []) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '';
    const data = pairs.length ? pairs : [{ key: '', value: '' }];
    data.forEach((pair) => addKeyValueFieldInternal(containerId, pair.key || '', pair.value || ''));
    syncKeyValueFieldRemoveButtons(container);
}

function readKeyValueFields(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];

    const fields = [];
    container.querySelectorAll('.kv-row').forEach((row) => {
        const key = (row.querySelector('.kv-key')?.value || '').trim();
        const value = (row.querySelector('.kv-value')?.value || '').trim();
        if (!key || !value) return;
        fields.push({ key, value });
    });
    return fields;
}

window.addKeyValueField = function(containerId) {
    addKeyValueFieldInternal(containerId);
    syncKeyValueFieldRemoveButtons(document.getElementById(containerId));
};

window.removeKeyValueField = function(buttonEl) {
    const row = buttonEl?.closest('.kv-row');
    const container = row?.parentElement;
    if (!row || !container) return;

    if (container.querySelectorAll('.kv-row').length <= 1) {
        syncKeyValueFieldRemoveButtons(container);
        return;
    }

    row.remove();
    if (!container.querySelector('.kv-row')) {
        addKeyValueFieldInternal(container.id);
    }
    syncKeyValueFieldRemoveButtons(container);
};

function renderGroupMemberRows(people = []) {
    if (!Array.isArray(people) || people.length === 0) {
        return '<div class="member-empty">No people found.</div>';
    }

    return people.map((person) => {
        const fullName = `${person.firstName || ''} ${person.lastName || ''}`.trim() || 'Untitled Person';
        return `
            <label class="member-item" data-member-label="${escapeHtml(fullName.toLowerCase())}">
                <input type="checkbox" class="group-member-checkbox" value="${escapeHtml(person.id)}">
                <span class="member-name">${escapeHtml(fullName)}</span>
            </label>
        `;
    }).join('');
}

function filterGroupMemberRows(term = '') {
    const normalized = String(term || '').trim().toLowerCase();
    document.querySelectorAll('.member-item[data-member-label]').forEach((row) => {
        const label = row.dataset.memberLabel || '';
        row.style.display = label.includes(normalized) ? 'flex' : 'none';
    });
}

function bindGroupMemberSearch() {
    const searchInput = document.getElementById('group-member-search');
    if (!searchInput) return;

    searchInput.addEventListener('input', (event) => {
        filterGroupMemberRows(event.target.value);
    });
}

// --- GLOBAL HELPERS (Attached to Window for HTML onclick access) ---

window.showEmptyState = function() {
    document.getElementById('empty-state').style.display = 'flex';
    document.getElementById('editor-form').style.display = 'none';
};

window.showEditor = function() {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('editor-form').style.display = 'flex';
};

window.renderList = function() {
    const data = getStoredData();
    let items = data[activeSection] || [];
    const container = document.getElementById('list-scroll');
    if(!container) return;

    container.innerHTML = '';

    if (searchQuery) {
        items = items.filter((item) => {
            const baseText = (activeSection === 'People')
                ? `${item.firstName || ''} ${item.lastName || ''} ${item.nickname || ''}`
                : (item.name || item.title || '');
            return baseText.toLowerCase().includes(searchQuery);
        });
    }

    if (items.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-dim); font-size:12px;">${searchQuery ? 'No matches' : 'No items'}</div>`;
        return;
    }

    items.forEach((item) => {
        const el = document.createElement('div');
        el.className = `card ${currentItemId === item.id ? 'selected' : ''}`;
        el.onclick = () => window.loadItemIntoEditor(item.id);

        let displayTitle = "Untitled";
        if (activeSection === 'People') displayTitle = `${item.firstName || ''} ${item.lastName || ''}`.trim() || "Untitled Person";
        else if (activeSection === 'Groups') displayTitle = item.name || "Untitled Group";
        else displayTitle = item.title || "Untitled Note";

        el.innerHTML = `<div class="card-title">${displayTitle}</div>`;
        container.appendChild(el);
    });
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    try {
        loadSettings();
        initEditors();

        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value.toLowerCase();
                window.renderList();
            });
        }

        window.addEventListener('popstate', () => {
            const pageId = getPageFromUrl();
            window.loadPage(pageId, getSidebarIcon(pageId), { skipHistory: true });
        });

        const initialPageId = getPageFromUrl();
        window.renderList();
        window.loadPage(initialPageId, getSidebarIcon(initialPageId), { replaceHistory: true });
    } finally {
        document.body.classList.remove('app-init');
    }
});

// --- GLOBAL NAVIGATION ---

window.loadPage = function(pageId, icon, options = {}) {
    const { skipHistory = false, replaceHistory = false } = options;
    const targetPage = document.getElementById(pageId) ? pageId : 'notes-page';

    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active-page'));
    const pageEl = document.getElementById(targetPage);
    if(pageEl) pageEl.classList.add('active-page');

    document.querySelectorAll('.sidebar-icon').forEach((i) => i.classList.remove('active-icon'));
    const resolvedIcon = icon || getSidebarIcon(targetPage);
    if(resolvedIcon) resolvedIcon.classList.add('active-icon');

    if (!skipHistory) {
        const currentUrlPage = getPageFromUrl();
        if (replaceHistory || currentUrlPage !== targetPage) {
            syncUrlToPage(targetPage, replaceHistory);
        }
    }

    if (targetPage === 'insights-page') renderInsights();
    if (targetPage === 'llm-page') initLLMPage();
    if (targetPage === 'graph-page') initGraphPage();
};

window.switchSection = function(section, element) {
    activeSection = section;
    currentItemId = null;
    searchQuery = '';

    const searchInput = document.getElementById('search-input');
    if(searchInput) searchInput.value = '';

    document.querySelectorAll('.tab-btn').forEach((el) => el.classList.remove('active-tab'));
    if(element) element.classList.add('active-tab');

    if (section === 'Me') {
        document.getElementById('dashboard-layout').style.display = 'none';
        document.getElementById('me-view').style.display = 'block';
        loadMeData();
    } else {
        document.getElementById('me-view').style.display = 'none';
        document.getElementById('dashboard-layout').style.display = 'flex';

        const listCount = document.getElementById('list-count');
        if(listCount) listCount.innerText = section;

        window.showEmptyState();
        window.renderList();
    }
};

window.loadItemIntoEditor = function(id) {
    currentItemId = id;
    window.renderList();

    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('editor-form').style.display = 'flex';
    setupFormFields();

    const data = getStoredData();
    let item = null;
    let foundSection = activeSection;

    const activeItems = data[activeSection] || [];
    item = activeItems.find((entry) => entry.id === id) || null;

    if (!item) {
        for (const sec of ['People', 'Groups', 'Notes']) {
            const found = (data[sec] || []).find((entry) => entry.id === id);
            if (found) {
                item = found;
                foundSection = sec;
                break;
            }
        }
    }

    if (!item) return;

    if (foundSection !== activeSection) {
        const tab = Array.from(document.querySelectorAll('.tab-btn')).find((b) => b.innerText === foundSection);
        window.switchSection(foundSection, tab);
        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('editor-form').style.display = 'flex';
        setupFormFields();
    }

    if (activeSection === 'People') {
        document.getElementById('inp-first').value = item.firstName || '';
        document.getElementById('inp-last').value = item.lastName || '';
        document.getElementById('inp-nickname').value = item.nickname || '';
        setDateInputs('inp-bday-month', 'inp-bday-day', 'inp-bday-year', item.birthday);
        renderKeyValueFields('people-custom-fields', normalizeExtraFields(item));
        quill.root.innerHTML = item.notes || '';
    } else if (activeSection === 'Groups') {
        document.getElementById('edit-title-input').value = item.name || "";
        document.querySelectorAll('.group-member-checkbox').forEach((cb) => { cb.checked = false; });
        (item.members || []).forEach((mId) => {
            const cb = document.querySelector(`.group-member-checkbox[value="${mId}"]`);
            if(cb) cb.checked = true;
        });
        filterGroupMemberRows(document.getElementById('group-member-search')?.value || '');
        quill.root.innerHTML = item.description || '';
    } else {
        document.getElementById('edit-title-input').value = item.title || "";
        quill.root.innerHTML = item.body || item.details || item.notes || '';
    }
};

function setupFormFields() {
    const container = document.getElementById('dynamic-meta-fields');
    const titleInput = document.getElementById('edit-title-input');

    if (activeSection === 'People') {
        titleInput.style.display = 'none';
        container.innerHTML = `
            <div class="input-group"><label class="input-label">First Name *</label><input id="inp-first" class="clean-input" type="text" oninput="this.classList.remove('input-error')"></div>
            <div class="input-group"><label class="input-label">Last Name</label><input id="inp-last" class="clean-input" type="text"></div>
            <div class="input-group"><label class="input-label">Nickname</label><input id="inp-nickname" class="clean-input" type="text"></div>
            <div class="input-group"><label class="input-label">Birthday</label>
                <div class="date-input-group">
                    <select id="inp-bday-month" class="clean-input">
                        <option value="">Month</option><option value="01">Jan</option><option value="02">Feb</option><option value="03">Mar</option>
                        <option value="04">Apr</option><option value="05">May</option><option value="06">Jun</option><option value="07">Jul</option>
                        <option value="08">Aug</option><option value="09">Sep</option><option value="10">Oct</option><option value="11">Nov</option><option value="12">Dec</option>
                    </select>
                    <input id="inp-bday-day" class="clean-input" type="number" placeholder="Day">
                    <input id="inp-bday-year" class="clean-input" type="number" placeholder="Year">
                </div>
            </div>
            <div class="input-group" style="grid-column: span 2;">
                <label class="input-label">Custom Fields</label>
                <div id="people-custom-fields" class="kv-fields"></div>
                <button class="btn btn-delete kv-add-btn" type="button" onclick="addKeyValueField('people-custom-fields')">
                    <span class="material-symbols-outlined" style="font-size:16px">add</span> Add Field
                </button>
            </div>
        `;
        renderKeyValueFields('people-custom-fields', []);
    } else {
        titleInput.style.display = 'block';
        if (activeSection === 'Groups') {
            titleInput.placeholder = "Group Name";
            const data = getStoredData();
            const membersHtml = renderGroupMemberRows(data.People || []);
            container.innerHTML = `
                <div class="input-group group-members-group" style="grid-column: span 2">
                    <label class="input-label">Add People</label>
                    <input id="group-member-search" class="clean-input group-member-search" type="text" placeholder="Search people...">
                    <div class="member-list-container">${membersHtml}</div>
                </div>
            `;
            bindGroupMemberSearch();
            filterGroupMemberRows('');
        } else {
            titleInput.placeholder = "Note Title";
            container.innerHTML = '';
        }
    }
}

window.createNewItem = function() {
    currentItemId = null;
    document.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('editor-form').style.display = 'flex';
    setupFormFields();
    document.getElementById('edit-title-input').value = '';
    document.querySelectorAll('#editor-form .clean-input').forEach((i) => { i.value = ''; });
    quill.setText('');

    if (activeSection === 'People') {
        renderKeyValueFields('people-custom-fields', []);
        setTimeout(() => {
            const first = document.getElementById('inp-first');
            if(first) first.focus();
        }, 50);
    } else {
        document.getElementById('edit-title-input').focus();
    }
};

window.handleSave = function() {
    if (quill.getText().length > 50000) return alert("Text too long!");
    const data = getStoredData();
    const sectionItems = data[activeSection] || [];
    let newItem = { lastEdited: new Date().toISOString() };

    if (activeSection === 'People') {
        const firstName = document.getElementById('inp-first').value.trim();
        if (!firstName) return document.getElementById('inp-first').classList.add('input-error');

        newItem = {
            ...newItem,
            firstName,
            lastName: document.getElementById('inp-last').value.trim(),
            nickname: document.getElementById('inp-nickname').value.trim(),
            birthday: getDateString('inp-bday-month', 'inp-bday-day', 'inp-bday-year'),
            notes: quill.root.innerHTML,
            lastContacted: new Date().toISOString(),
            extraFields: readKeyValueFields('people-custom-fields')
        };
    } else if (activeSection === 'Groups') {
        const selectedMembers = Array.from(document.querySelectorAll('.group-member-checkbox:checked')).map((cb) => cb.value);
        newItem = {
            ...newItem,
            name: document.getElementById('edit-title-input').value.trim(),
            members: selectedMembers,
            description: quill.root.innerHTML
        };
    } else {
        newItem = {
            ...newItem,
            title: document.getElementById('edit-title-input').value.trim(),
            body: quill.root.innerHTML
        };
    }

    if (currentItemId) {
        newItem.id = currentItemId;
        data[activeSection] = sectionItems.filter((i) => i.id !== currentItemId);
    } else {
        newItem.id = Date.now().toString();
        if (!Array.isArray(data[activeSection])) data[activeSection] = [];
        currentItemId = newItem.id;
    }

    data[activeSection].unshift(newItem);
    saveStoredData(data);

    if (activeSection === 'People' || activeSection === 'Groups' || activeSection === 'Notes') {
        let content = "";
        let context = activeSection.toLowerCase();
        const meta = { source: 'Organizer App', type: activeSection.toLowerCase() };
        const tags = [`section:${activeSection.toLowerCase()}`];

        if (activeSection === 'People') {
            const name = `${newItem.firstName} ${newItem.lastName}`.trim();
            const extra = (newItem.extraFields || []).map((f) => `${f.key}: ${f.value}`).join('\n') || 'N/A';
            content = `PERSON PROFILE: ${name}\nNickname: ${newItem.nickname || 'N/A'}\nBirthday: ${newItem.birthday || 'N/A'}\nCustom Fields:\n${extra}\nBio/Notes:\n${newItem.notes || ''}`;
            context = 'person_profile';
            meta.name = name;
            tags.push(`person:${newItem.id}`);
        } else if (activeSection === 'Groups') {
            content = `GROUP: ${newItem.name}\nDescription:\n${newItem.description || ''}`;
            context = 'group_profile';
            meta.name = newItem.name;
            tags.push(`group:${newItem.id}`);
        } else {
            content = `NOTE: ${newItem.title || 'Untitled Note'}\n${newItem.body || ''}`;
            context = 'note';
            meta.title = newItem.title || 'Untitled Note';
            tags.push(`note:${newItem.id}`);
        }

        const hashTags = extractHashtags(content);
        const mergedTags = cleanTagValues([...tags, ...hashTags]);

        hindsight.syncDocument(newItem.id, content, {
            metadata: meta,
            timestamp: newItem.lastEdited,
            context,
            tags: mergedTags,
            documentTags: mergedTags
        });
    }

    window.renderList();
    const saveBtn = document.querySelector('#editor-pane .btn-save');
    const originalText = saveBtn.innerText;
    saveBtn.innerText = "Saved";
    setTimeout(() => { saveBtn.innerText = originalText; }, 1000);
};

window.handleDelete = function() {
    if(!currentItemId || !confirm("Delete this item permanently?")) return;
    if (activeSection === 'People' || activeSection === 'Groups' || activeSection === 'Notes') {
        hindsight.deleteDocument(currentItemId);
    }

    const data = getStoredData();
    data[activeSection] = (data[activeSection] || []).filter((i) => i.id !== currentItemId);
    saveStoredData(data);
    currentItemId = null;
    window.showEmptyState();
    window.renderList();
};

window.updateUIDensity = function(val) {
    appSettings.uiDensity = ['compact', 'default', 'spacious'].includes(val) ? val : 'default';
    saveSettings();
};
window.updateGraphSpacing = function(val) {
    const numeric = Number(val);
    appSettings.graphSpacing = Number.isFinite(numeric)
        ? Math.min(260, Math.max(40, Math.round(numeric)))
        : 100;
    saveSettings();

    const graphPage = document.getElementById('graph-page');
    if (graphPage && graphPage.classList.contains('active-page') && typeof window.refreshGraphData === 'function') {
        window.refreshGraphData();
    }
};
window.previewGraphSpacing = function(val) {
    const label = document.getElementById('graph-spacing-value');
    if (!label) return;

    const numeric = Number(val);
    if (!Number.isFinite(numeric)) return;
    label.textContent = `${Math.min(260, Math.max(40, Math.round(numeric)))}%`;
};
window.updateReasoningBudget = function(val) {
    appSettings.reasoningBudget = ['low', 'mid', 'high'].includes(val) ? val : 'mid';
    saveSettings();
};
window.toggleAgentReflect = function(checked) {
    appSettings.agentUseReflect = !!checked;
    saveSettings();
};
window.toggleAgentMemorySave = function(checked) {
    appSettings.agentSaveConversation = !!checked;
    saveSettings();
};
window.toggleBlur = function(checked) { appSettings.blurMode = checked; saveSettings(); };
window.resetAppearance = function() {
    if(!confirm("Reset visual settings?")) return;
    localStorage.removeItem('organizerSettings');
    location.reload();
};
window.exportData = function() {
    const blob = new Blob([localStorage.getItem('organizerData')], {type: "application/json"});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `crm_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
};
window.nukeData = async function() {
    if(!confirm("⚠️ DANGER ZONE ⚠️\n\nDelete all local data AND Hindsight memories?\n\n(Cannot be undone)")) return;
    const btn = document.querySelector('.btn-nuke');
    if(btn) btn.innerText = "Wiping...";
    await hindsight.clearBank();
    localStorage.clear();
    location.reload();
};

function loadMeData() {
    const storedMe = localStorage.getItem('organizer-me');
    if(!storedMe) {
        renderKeyValueFields('me-custom-fields', []);
        return;
    }

    let data;
    try {
        data = JSON.parse(storedMe);
    } catch {
        renderKeyValueFields('me-custom-fields', []);
        return;
    }

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if(el) el.value = val || '';
    };

    setVal('me-first', data.firstName);
    setVal('me-last', data.lastName);
    setVal('me-nickname', data.nickname);
    setDateInputs('me-bday-month', 'me-bday-day', 'me-bday-year', data.birthday);
    renderKeyValueFields('me-custom-fields', normalizeExtraFields(data));
    quillMe.root.innerHTML = data.bio || '';
}

window.saveMeData = function() {
    const firstName = document.getElementById('me-first').value.trim();
    const lastName = document.getElementById('me-last').value.trim();
    const nickname = document.getElementById('me-nickname').value.trim();
    const birthday = getDateString('me-bday-month', 'me-bday-day', 'me-bday-year');
    const extraFields = readKeyValueFields('me-custom-fields');
    const bio = quillMe.root.innerHTML;
    const lastEdited = new Date().toISOString();

    const meData = {
        firstName,
        lastName,
        nickname,
        birthday,
        extraFields,
        bio,
        lastEdited
    };
    localStorage.setItem('organizer-me', JSON.stringify(meData));

    const fullName = `${firstName} ${lastName}`.trim();
    const extras = extraFields.map((field) => `${field.key}: ${field.value}`).join('\n') || 'N/A';
    const profileContent = [
        `ME PROFILE: ${fullName || 'User'}`,
        `Nickname: ${nickname || 'N/A'}`,
        `Birthday: ${birthday || 'N/A'}`,
        'Custom Fields:',
        extras,
        'Bio / Context:',
        bio || 'N/A'
    ].join('\n');

    const meTags = cleanTagValues([
        'section:me',
        'profile:self',
        'entity:user',
        ...extractHashtags(profileContent)
    ]);

    hindsight.syncDocument('me-profile', profileContent, {
        metadata: {
            source: 'Organizer App',
            type: 'me',
            name: fullName || 'User'
        },
        timestamp: lastEdited,
        context: 'me_profile',
        tags: meTags,
        documentTags: meTags
    });

    const btn = document.querySelector('#me-view .btn-save');
    const originalText = btn.innerText;
    btn.innerText = "Saved";
    setTimeout(() => { btn.innerText = originalText; }, 1500);
};
