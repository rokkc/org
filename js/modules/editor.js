import { getStoredData, appSettings } from '../core/store.js';

export let quill, quillMe;

export function initEditors(onTextChange) {
    const toolbarOptions = [
        ['bold', 'italic', 'underline', 'strike'],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        [{ 'header': [1, 2, 3, false] }],
        ['link', 'clean']
    ];

    // Initialize the main editor
    quill = new Quill('#quill-editor', { 
        theme: 'snow', 
        placeholder: 'Write details...', 
        modules: { toolbar: toolbarOptions } 
    });

    // Initialize the "Me" profile editor
    quillMe = new Quill('#quill-me-editor', { 
        theme: 'snow', 
        placeholder: 'Your story...', 
        modules: { toolbar: toolbarOptions } 
    });

    // Attach mention handler to both
    quill.on('text-change', (delta, oldDelta, source) => { 
        if (source === 'user') handleMentionsInput(quill);
        if (onTextChange) onTextChange();
    });
    
    // Optional: Add mentions to the "Me" editor too if desired
    quillMe.on('text-change', (delta, oldDelta, source) => {
        if (source === 'user') handleMentionsInput(quillMe);
    });
}

function handleMentionsInput(editorInstance) {
    const range = editorInstance.getSelection();
    if (!range) return;
    
    // Check if the character just typed (or before cursor) is '@'
    // range.index is the cursor position. We look at the char before it.
    const textBefore = editorInstance.getText(range.index - 1, 1);
    
    const popup = document.getElementById('mention-popup');

    if (textBefore === '@') {
        const bounds = editorInstance.getBounds(range.index);
        
        // Calculate position relative to the editor container
        const editorRect = editorInstance.container.getBoundingClientRect();
        
        popup.style.left = (editorRect.left + bounds.left) + 'px';
        popup.style.top = (editorRect.top + bounds.top + 20) + 'px';
        
        const data = getStoredData();
        const people = data.People || [];
        
        if (people.length === 0) { 
            popup.style.display = 'none'; 
            return; 
        }
        
        // Render the list
        popup.innerHTML = people.map(p => 
            `<div class="mention-option" data-name="${p.firstName} ${p.lastName}">
                ${p.firstName} ${p.lastName}
             </div>`
        ).join('');
        
        // Add click listeners
        popup.querySelectorAll('.mention-option').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                insertMention(editorInstance, el.dataset.name);
            });
        });

        popup.style.display = 'block';
    } else { 
        popup.style.display = 'none'; 
    }
}

function insertMention(editorInstance, name) {
    const range = editorInstance.getSelection();
    if(!range) return;

    // Delete the '@'
    editorInstance.deleteText(range.index - 1, 1);
    
    // Insert the name with styling
    editorInstance.insertText(range.index - 1, name, { 
        'color': appSettings.accent, 
        'bold': true 
    });
    
    // Insert a space after
    editorInstance.insertText(range.index - 1 + name.length, ' '); 
    
    // Hide popup
    document.getElementById('mention-popup').style.display = 'none';
}