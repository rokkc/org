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

    // Filter
    if (searchQuery) items = items.filter(item => {
        let text = (activeSection === 'People') ? `${item.firstName} ${item.lastName} ${item.nickname || ''}` : (item.name || item.title);
        return text.toLowerCase().includes(searchQuery);
    });

    // Sort
    if (appSettings.sortOrder === 'alpha') items.sort((a, b) => {
        let nameA = (a.firstName || a.name || a.title || "").toLowerCase();
        let nameB = (b.firstName || b.name || b.title || "").toLowerCase();
        return nameA.localeCompare(nameB);
    });

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
        else displayTitle = item.title || "Untitled Item";
        
        el.innerHTML = `<div class="card-title">${displayTitle}</div>`;
        container.appendChild(el);
    });
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    initEditors(); 
    
    // Wire up global search
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => { 
            searchQuery = e.target.value.toLowerCase(); 
            window.renderList(); 
        });
    }

    // Initial Render
    window.renderList();
});

// --- GLOBAL NAVIGATION ---

window.loadPage = function(pageId, icon) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active-page'));
    const pageEl = document.getElementById(pageId);
    if(pageEl) pageEl.classList.add('active-page');
    
    document.querySelectorAll('.sidebar-icon').forEach(i => i.classList.remove('active-icon'));
    if(icon) icon.classList.add('active-icon');
    
    if (pageId === 'insights-page') renderInsights();
    if (pageId === 'llm-page') initLLMPage();
    if (pageId === 'graph-page') initGraphPage(); 
};

window.switchSection = function(section, element) {
    activeSection = section;
    currentItemId = null;
    searchQuery = '';
    
    const searchInput = document.getElementById('search-input');
    if(searchInput) searchInput.value = '';
    
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active-tab'));
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
    
    if (data[activeSection].find(i => i.id === id)) {
        item = data[activeSection].find(i => i.id === id);
    } else {
        // Fallback search
        for (const sec of ['People', 'Groups', 'Items', 'General']) {
            const found = (data[sec] || []).find(i => i.id === id);
            if (found) {
                item = found;
                foundSection = sec;
                break;
            }
        }
    }
    
    if (!item) return;

    if (foundSection !== activeSection) {
        const tab = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.innerText === foundSection);
        window.switchSection(foundSection, tab);
    }

    if (activeSection === 'People') {
        document.getElementById('inp-first').value = item.firstName || '';
        document.getElementById('inp-last').value = item.lastName || '';
        document.getElementById('inp-nickname').value = item.nickname || '';
        setDateInputs('inp-bday-month', 'inp-bday-day', 'inp-bday-year', item.birthday);
        document.getElementById('inp-phone').value = item.phone || '';
        
        const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val || ''; };
        setVal('inp-linkedin', item.linkedin);
        setVal('inp-insta', item.instagram);
        setVal('inp-x', item.twitter);
        setVal('inp-discord', item.discord);
        
        quill.root.innerHTML = item.notes || '';
    } 
    else if (activeSection === 'Groups') {
        document.getElementById('edit-title-input').value = item.name || "";
        document.querySelectorAll('.group-member-checkbox').forEach(cb => cb.checked = false);
        (item.members || []).forEach(mId => {
            const cb = document.querySelector(`.group-member-checkbox[value="${mId}"]`);
            if(cb) cb.checked = true;
        });
        quill.root.innerHTML = item.description || '';
    }
    else {
        document.getElementById('edit-title-input').value = item.title || "";
        quill.root.innerHTML = item.body || item.details || '';
        if(activeSection === 'Items') {
             const typeEl = document.getElementById('inp-type');
             if(typeEl) typeEl.value = item.type || 'Object';
             const statEl = document.getElementById('inp-status');
             if(statEl) statEl.value = item.status || '';
        }
    }
};

function setupFormFields() {
    const container = document.getElementById('dynamic-meta-fields');
    const titleInput = document.getElementById('edit-title-input');
    
    if (activeSection === 'People') {
        titleInput.style.display = 'none'; 
        let socialFields = '';
        if(appSettings.visibleFields.linkedin) socialFields += `<div class="input-group"><label class="input-label">LinkedIn</label><input id="inp-linkedin" class="clean-input" type="text"></div>`;
        if(appSettings.visibleFields.instagram) socialFields += `<div class="input-group"><label class="input-label">Instagram</label><input id="inp-insta" class="clean-input" type="text"></div>`;
        if(appSettings.visibleFields.twitter) socialFields += `<div class="input-group"><label class="input-label">X (Twitter)</label><input id="inp-x" class="clean-input" type="text"></div>`;
        if(appSettings.visibleFields.discord) socialFields += `<div class="input-group"><label class="input-label">Discord</label><input id="inp-discord" class="clean-input" type="text"></div>`;

        container.innerHTML = `
            <div class="input-group"><label class="input-label">First Name *</label><input id="inp-first" class="clean-input" type="text" oninput="this.classList.remove('input-error')"></div>
            <div class="input-group"><label class="input-label">Last Name</label><input id="inp-last" class="clean-input" type="text"></div>
            <div class="input-group"><label class="input-label">Nickname</label><input id="inp-nickname" class="clean-input" type="text"></div>
            <div class="input-group"><label class="input-label">Phone</label><input id="inp-phone" class="clean-input" type="tel"></div>
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
            ${socialFields}
        `;
    } else {
        titleInput.style.display = 'block';
        if (activeSection === 'Groups') {
            titleInput.placeholder = "Group Name";
            const data = getStoredData();
            let membersHtml = (data.People || []).map(p => `
                <label class="member-item" style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
                    <input type="checkbox" class="group-member-checkbox" value="${p.id}">
                    <span class="member-name">${p.firstName} ${p.lastName}</span>
                </label>`).join('');
            if(!membersHtml) membersHtml = '<div style="padding:10px; color:var(--text-dim); font-size:0.8em">No people found.</div>';
            container.innerHTML = `<div class="input-group" style="grid-column: span 2"><label class="input-label">Add People</label><div class="member-list-container" style="max-height:100px; overflow-y:auto; border:1px solid var(--border-subtle); padding:10px;">${membersHtml}</div></div>`;
        } else if (activeSection === 'Items') {
            titleInput.placeholder = "Item Title";
            container.innerHTML = `
                <div class="input-group"><label class="input-label">Type</label><select id="inp-type" class="clean-input"><option>Book</option><option>Event</option><option>Task</option><option>Object</option></select></div>
                <div class="input-group"><label class="input-label">Status</label><input id="inp-status" class="clean-input" type="text"></div>
            `;
        } else {
            titleInput.placeholder = "Note Title";
            container.innerHTML = '';
        }
    }
}

window.createNewItem = function() {
    currentItemId = null;
    document.querySelectorAll('.card').forEach(c => c.classList.remove('selected'));
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('editor-form').style.display = 'flex';
    setupFormFields(); 
    document.getElementById('edit-title-input').value = '';
    document.querySelectorAll('.clean-input').forEach(i => i.value = '');
    quill.setText('');
    
    if (activeSection === 'People') setTimeout(() => {
        const first = document.getElementById('inp-first');
        if(first) first.focus();
    }, 50);
    else document.getElementById('edit-title-input').focus();
};

window.handleSave = function() {
    if (quill.getText().length > 50000) return alert("Text too long!");
    const data = getStoredData();
    let newItem = { lastEdited: new Date().toISOString() };
    const oldItem = currentItemId ? data[activeSection].find(i => i.id === currentItemId) : null;

    if (activeSection === 'People') {
        const fName = document.getElementById('inp-first').value.trim();
        if (!fName) return document.getElementById('inp-first').classList.add('input-error');
        
        newItem = { ...newItem,
            firstName: fName,
            lastName: document.getElementById('inp-last').value.trim(),
            nickname: document.getElementById('inp-nickname').value.trim(),
            phone: document.getElementById('inp-phone').value.trim(),
            birthday: getDateString('inp-bday-month', 'inp-bday-day', 'inp-bday-year'),
            notes: quill.root.innerHTML,
            lastContacted: new Date().toISOString()
        };
        const saveField = (key, domId) => {
            if (appSettings.visibleFields[key]) {
                const el = document.getElementById(domId);
                newItem[key] = el ? el.value.trim() : "";
            } else if (oldItem) {
                newItem[key] = oldItem[key]; 
            }
        };
        saveField('linkedin', 'inp-linkedin');
        saveField('instagram', 'inp-insta');
        saveField('twitter', 'inp-x');
        saveField('discord', 'inp-discord');
        
    } else if (activeSection === 'Groups') {
        const selectedMembers = Array.from(document.querySelectorAll('.group-member-checkbox:checked')).map(cb => cb.value);
        newItem = { ...newItem, name: document.getElementById('edit-title-input').value.trim(), members: selectedMembers, description: quill.root.innerHTML };
    } else {
        newItem = { ...newItem, title: document.getElementById('edit-title-input').value.trim(), body: quill.root.innerHTML };
        if(activeSection === 'Items') {
            newItem.type = document.getElementById('inp-type').value;
            newItem.status = document.getElementById('inp-status').value.trim();
        }
    }

    if (currentItemId) {
        newItem.id = currentItemId;
        data[activeSection] = data[activeSection].filter(i => i.id !== currentItemId);
    } else {
        newItem.id = Date.now().toString();
        currentItemId = newItem.id; 
    }

    data[activeSection].unshift(newItem); 
    saveStoredData(data);
    
    // Hindsight Sync
    if (activeSection === 'People' || activeSection === 'Groups') {
        let content = "";
        let meta = { source: 'Organizer App', type: activeSection.toLowerCase() };

        if (activeSection === 'People') {
            const name = `${newItem.firstName} ${newItem.lastName}`;
            content = `PERSON PROFILE: ${name}\nNickname: ${newItem.nickname || 'N/A'}\nPhone: ${newItem.phone || 'N/A'}\nBirthday: ${newItem.birthday || 'N/A'}\nBio/Notes:\n${newItem.notes || ''}`;
            meta.name = name;
        } 
        else if (activeSection === 'Groups') {
            content = `GROUP: ${newItem.name}\nDescription:\n${newItem.description || ''}`;
            meta.name = newItem.name;
        }
        hindsight.syncDocument(newItem.id, content, meta);
    }

    window.renderList();
    const saveBtn = document.querySelector('#editor-pane .btn-save');
    const originalText = saveBtn.innerText;
    saveBtn.innerText = "Saved";
    setTimeout(() => saveBtn.innerText = originalText, 1000);
};

window.handleDelete = function() {
    if(!currentItemId || !confirm("Delete this item permanently?")) return;
    if (activeSection === 'People' || activeSection === 'Groups') hindsight.deleteDocument(currentItemId);
    
    const data = getStoredData();
    data[activeSection] = data[activeSection].filter(i => i.id !== currentItemId);
    saveStoredData(data);
    currentItemId = null;
    window.showEmptyState();
    window.renderList();
};

window.toggleField = function(field, checked) {
    appSettings.visibleFields[field] = checked;
    saveSettings();
    if (activeSection === 'People' && currentItemId) window.loadItemIntoEditor(currentItemId);
};

window.updateAccent = function(val) { appSettings.accent = val; saveSettings(); };
window.updateFontSize = function(val) { appSettings.fontSize = val; saveSettings(); };
window.updateSortOrder = function(val) { appSettings.sortOrder = val; saveSettings(); window.renderList(); };
window.toggleBlur = function(checked) { appSettings.blurMode = checked; saveSettings(); };
window.resetAppearance = function() { if(!confirm("Reset visual settings?")) return; localStorage.removeItem('organizerSettings'); location.reload(); };
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
    if(!storedMe) return;
    const data = JSON.parse(storedMe);
    const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val || ''; };
    setVal('me-first', data.firstName);
    setVal('me-last', data.lastName);
    setVal('me-nickname', data.nickname);
    setVal('me-phone', data.phone);
    setVal('me-linkedin', data.linkedin);
    setVal('me-insta', data.instagram);
    setVal('me-x', data.twitter);
    setVal('me-discord', data.discord);
    setDateInputs('me-bday-month', 'me-bday-day', 'me-bday-year', data.birthday);
    quillMe.root.innerHTML = data.bio || '';
}

window.saveMeData = function() {
    const meData = {
        firstName: document.getElementById('me-first').value,
        lastName: document.getElementById('me-last').value,
        nickname: document.getElementById('me-nickname').value,
        phone: document.getElementById('me-phone').value,
        birthday: getDateString('me-bday-month', 'me-bday-day', 'me-bday-year'),
        linkedin: document.getElementById('me-linkedin').value,
        instagram: document.getElementById('me-insta').value,
        twitter: document.getElementById('me-x').value,
        discord: document.getElementById('me-discord').value,
        bio: quillMe.root.innerHTML
    };
    localStorage.setItem('organizer-me', JSON.stringify(meData));
    const btn = document.querySelector('#me-view .btn-save');
    const originalText = btn.innerText;
    btn.innerText = "Saved";
    setTimeout(() => btn.innerText = originalText, 1500);
};