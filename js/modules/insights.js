import { getStoredData } from '../core/store.js';

export function renderInsights() {
    const container = document.getElementById('insights-content');
    if (!container) return;
    
    const data = getStoredData();
    const people = data.People || [];
    const today = new Date();

    // 1. Calculate Birthdays
    const upcomingBirthdays = people.filter(p => p.birthday).map(p => {
        let bDateStr = p.birthday;
        // Fix 0000 years for calculation purposes
        if(bDateStr.startsWith("0000")) bDateStr = bDateStr.replace("0000", today.getFullYear());
        
        const bday = new Date(bDateStr);
        bday.setFullYear(today.getFullYear());
        
        // If birthday passed this year, look at next year
        if (bday < today) bday.setFullYear(today.getFullYear() + 1);
        
        const diffTime = Math.abs(bday - today);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        return { ...p, daysIn: diffDays };
    })
    .sort((a,b) => a.daysIn - b.daysIn)
    .slice(0, 5); // Top 5

    // 2. Calculate Catch-ups (90+ days since last contact)
    const catchUpList = people.filter(p => {
        if (!p.lastContacted) return false; 
        const last = new Date(p.lastContacted);
        const diff = (today - last) / (1000 * 60 * 60 * 24);
        return diff > 90;
    }).slice(0, 5);

    // 3. Render
    let html = '';
    
    if (upcomingBirthdays.length === 0 && catchUpList.length === 0) {
        html = `<div style="text-align:center; color:var(--text-dim); margin-top:50px;">
                    <span class="material-symbols-outlined" style="font-size:48px;">sentiment_satisfied</span>
                    <br><br>All caught up! Add birthdays to see insights here.
                </div>`;
    } else {
        if(upcomingBirthdays.length > 0) {
            html += `<div class="insight-box"><div class="insight-header">Upcoming Birthdays</div>`;
            upcomingBirthdays.forEach(p => {
                html += `<div class="insight-item" onclick="window.loadItemIntoEditor('${p.id}')">
                            <span>${p.firstName} ${p.lastName}</span>
                            <span class="insight-meta">${p.daysIn === 0 ? 'Today!' : 'In ' + p.daysIn + ' days'}</span>
                        </div>`;
            });
            html += `</div>`;
        }
        
        if(catchUpList.length > 0) {
            html += `<div class="insight-box"><div class="insight-header">Reconnect (90+ Days)</div>`;
            catchUpList.forEach(p => {
                html += `<div class="insight-item" onclick="window.loadItemIntoEditor('${p.id}')">
                            <span>${p.firstName} ${p.lastName}</span>
                            <span class="insight-meta alert-text">Needs Catch Up</span>
                        </div>`;
            });
            html += `</div>`;
        }
    }
    
    container.innerHTML = html;
}