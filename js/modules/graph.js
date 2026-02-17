import { hindsight } from '../services/hindsight.js';

// --- State ---
let graphSimulation = null;
let graphSvg = null;
let graphZoom = null;
let processedNodes = [];
let processedLinks = []; 
let activeNodeId = null; 
let isDragging = false;  
let wasActiveBeforeDrag = false;
let currentViewMode = 'graph'; 

// BATMAN / DETECTIVE PALETTE
const COLORS = {
    node: "#00bcd4",     // Ice Blue
    insight: "#ffffff",  // White
    standardLink: "#546e7a", 
    keyLink: "#ffc107",      // Amber
    activeEdge: "#ff00ff",   // Neon Pink
    bg: "#020202"
};

export function initGraphPage() {
    const page = document.getElementById('graph-page');
    if (!page) return;

    if (!document.getElementById('graph-controls-bar')) {
        page.innerHTML = `
            <div id="graph-controls-bar">
                <div class="graph-btn-group">
                    <div class="view-btn active" id="btn-view-graph">Network</div>
                    <div class="view-btn" id="btn-view-timeline">Timeline</div>
                </div>
                
                <div class="graph-btn-group">
                    <div class="view-btn" id="btn-reset-zoom" title="Reset Camera">
                        <span class="material-symbols-outlined" style="font-size:16px;">center_focus_strong</span>
                    </div>
                    <div class="view-btn" id="btn-refresh-graph" title="Refresh Intel">
                        <span class="material-symbols-outlined" style="font-size:16px;">refresh</span>
                    </div>
                </div>
            </div>
            
            <div id="graph-container"></div>
            
            <div id="graph-entity-sidebar">
                <div class="sidebar-search-container">
                    <input type="text" id="entity-sidebar-search" placeholder="FILTER ENTITIES...">
                </div>
                <div id="entity-list-content"></div>
            </div> 
            
            <div id="graph-legend">
                <div class="legend-header">Data Objects</div>
                <div class="legend-item"><div class="legend-dot" style="background:${COLORS.node}"></div>Memory Node</div>
                <div class="legend-item"><div class="legend-dot" style="background:${COLORS.insight}"></div>Insight</div>
                <div class="legend-header" style="margin-top:15px">Links</div>
                <div class="legend-item"><div class="legend-line" style="background:${COLORS.keyLink}; box-shadow:0 0 4px ${COLORS.keyLink}"></div>Key Link</div>
                <div class="legend-item"><div class="legend-line" style="background:${COLORS.activeEdge}"></div>Selected</div>
            </div>

            <div id="graph-timeline-view"></div>
            
            <div id="graph-details-panel">
                <div class="close-panel-btn"><span class="material-symbols-outlined" style="font-size:16px">close</span></div>
                <div style="font-size:0.7em; font-weight:700; margin-bottom:10px; color:#555; text-transform:uppercase; letter-spacing:3px" id="detail-type">DATA</div>
                <div id="detail-body"></div>
            </div>
        `;
        
        // Bind events
        document.getElementById('btn-view-graph').onclick = () => switchGraphView('graph');
        document.getElementById('btn-view-timeline').onclick = () => switchGraphView('timeline');
        document.getElementById('btn-reset-zoom').onclick = resetGraphZoom;
        document.getElementById('btn-refresh-graph').onclick = refreshGraphData;
        
        document.querySelector('.close-panel-btn').onclick = closeDetailPanel;
        
        document.getElementById('entity-sidebar-search').oninput = (e) => filterEntityList(e.target.value);
    }
    
    renderGraphView();
}

function resetGraphZoom() {
    if (graphSvg && graphZoom) {
        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;
        const scale = 2; 
        const tx = (width / 2) * (1 - scale);
        const ty = (height / 2) * (1 - scale);
        const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);

        graphSvg.transition().duration(750).call(graphZoom.transform, transform);
    }
}

export async function refreshGraphData() {
    const container = (currentViewMode === 'graph')
        ? document.getElementById('graph-container')
        : document.getElementById('graph-timeline-view');
                      
    if (!container) return;
    
    container.innerHTML = `<div style="display:flex; height:100%; align-items:center; justify-content:center; color:var(--accent); font-family:monospace; letter-spacing:2px; animation: pulse 1s infinite">SYNCING INTEL...</div>`;
    
    setTimeout(() => { 
        renderGraphView().then(() => {
            switchGraphView(currentViewMode);
        });
    }, 500);
}

// --- Data Fetch & Render ---
async function renderGraphView() {
    const container = document.getElementById('graph-container');
    const entitySidebarList = document.getElementById('entity-list-content');
    
    // Call Hindsight Service
    const apiData = await hindsight.getGraph();
    
    if (!apiData || !apiData.nodes || apiData.nodes.length === 0) {
        if(container) container.innerHTML = `<div class="empty-state" style="color:#333; font-family:monospace; letter-spacing:2px">NO DATA FOUND</div>`;
        return;
    }

    // Process Nodes
    let entityCounts = new Map();
    activeNodeId = null; 
    
    processedNodes = apiData.nodes.map((n) => {
        const d = n.data || n;
        let label = d.label || d.text || d.id;
        let type = "Memory";

        if (label.startsWith("##")) { label = "Insight"; type = "Insight"; }
        
        if(d.entities) {
            d.entities.split(',').forEach(e => {
                const cleanE = e.trim();
                if(cleanE) entityCounts.set(cleanE, (entityCounts.get(cleanE) || 0) + 1);
            });
        }

        return { 
            id: d.id, 
            label: label.length > 20 ? label.substring(0, 17) + "..." : label, 
            fullText: d.text || d.label, 
            type: type, 
            entities: d.entities || "", 
            entityList: d.entities ? d.entities.split(',').map(s=>s.trim()) : [],
            date: d.date || "", 
            r: type === 'Insight' ? 5 : 4, 
            color: type === 'Insight' ? COLORS.insight : COLORS.node
        };
    });

    // Process Links
    processedLinks = (apiData.edges || apiData.links || []).map(e => {
        const d = e.data || e;
        let type = (d.linkType || d.relation || "semantic").toLowerCase();
        
        let linkColor = COLORS.standardLink;
        let linkOpacity = 0.3;
        let dashed = "3,3"; 
        let width = 1;

        if (type === 'causal' || type.includes('entity')) {
            linkColor = COLORS.keyLink; 
            linkOpacity = 0.8;
            width = 1.5;
            dashed = "0"; 
        }

        return {
            source: d.source, target: d.target, type: type,
            dashed: dashed, color: linkColor, opacity: linkOpacity, width: width,
            originalColor: linkColor 
        };
    });

    // Render Sidebar
    if (entitySidebarList) {
        const sortedEntities = Array.from(entityCounts.entries()).sort((a,b) => b[1] - a[1]);
        entitySidebarList.innerHTML = sortedEntities.map(([name, count]) => `
            <div class="entity-pill" data-entity="${name}">
                <span>${name.toUpperCase()}</span> <span style="opacity:0.6; font-size:0.9em">[${count}]</span>
            </div>
        `).join('');
        
        entitySidebarList.querySelectorAll('.entity-pill').forEach(el => {
            el.addEventListener('mouseover', () => highlightEntity(el.dataset.entity));
            el.addEventListener('mouseout', () => resetHighlight());
            el.addEventListener('click', () => filterByEntity(el.dataset.entity));
        });
    }

    if (currentViewMode !== 'graph') return;

    // --- D3 Rendering ---
    container.innerHTML = ''; 
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (graphSimulation) graphSimulation.stop();

    graphZoom = d3.zoom().scaleExtent([0.1, 4]).on("zoom", (e) => g.attr("transform", e.transform));
    
    graphSvg = d3.select("#graph-container").append("svg")
        .attr("width", width).attr("height", height)
        .call(graphZoom)
        .on("dblclick.zoom", null);

    graphSvg.on("click", (event) => {
        if (event.target.tagName === 'svg') closeDetailPanel();
    });

    const g = graphSvg.append("g");

    // Initial Zoom
    const initScale = 2;
    graphSvg.call(graphZoom.transform, d3.zoomIdentity.translate((width/2)*(1-initScale), (height/2)*(1-initScale)).scale(initScale));

    graphSimulation = d3.forceSimulation(processedNodes)
        .force("link", d3.forceLink(processedLinks).id(d => d.id).distance(100)) 
        .force("charge", d3.forceManyBody().strength(-300)) 
        .force("center", d3.forceCenter(width / 2, height / 2));

    const link = g.append("g").attr("class", "links").selectAll("path")
        .data(processedLinks).enter().append("path")
        .attr("stroke", d => d.color).attr("stroke-width", d => d.width)
        .attr("stroke-dasharray", d => d.dashed).attr("fill", "none")
        .attr("opacity", d => d.opacity);

    const node = g.append("g").attr("class", "nodes").selectAll("g")
        .data(processedNodes).enter().append("g")
        .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended))
        .on("click", (event, d) => {
            event.stopPropagation();
            showNodeDetails(d);
        });

    node.append("circle")
        .attr("r", d => d.r).attr("fill", d => d.color).attr("stroke", "none");

    node.append("text").attr("dy", d => d.r + 8).attr("text-anchor", "middle")
        .text(d => d.label)
        .attr("fill", "#888") 
        .style("font-size", "4px") 
        .style("font-family", "'Roboto Mono', monospace")
        .style("pointer-events", "none").style("text-transform", "uppercase");

    graphSimulation.on("tick", () => {
        link.attr("d", d => {
            if (isNaN(d.source.x) || isNaN(d.target.x)) return "";
            return `M${d.source.x},${d.source.y} L${d.target.x},${d.target.y}`;
        });
        node.attr("transform", d => {
            if (isNaN(d.x)) return "";
            return `translate(${d.x},${d.y})`;
        });
    });
}

// --- Interaction Helpers ---

function highlightEntity(entityName) {
    if (isDragging) return;
    const svg = d3.select("#graph-container svg");
    if(svg.empty()) return;
    
    svg.selectAll(".nodes g").classed("node-dimmed", true).classed("node-highlight", false);
    svg.selectAll(".links path").classed("link-dimmed", true).attr("stroke", d => d.originalColor).attr("opacity", 0.1);

    const relevantNodes = svg.selectAll(".nodes g").filter(d => d.entityList.includes(entityName));
    relevantNodes.classed("node-dimmed", false).classed("node-highlight", true);

    const relevantIds = new Set(relevantNodes.data().map(d => d.id));
    svg.selectAll(".links path").filter(d => relevantIds.has(d.source.id) && relevantIds.has(d.target.id))
        .classed("link-dimmed", false)
        .attr("opacity", 1)
        .attr("stroke", COLORS.activeEdge);
}

function resetHighlight() {
    if (isDragging) return;
    if (activeNodeId) {
        applySelectionState(activeNodeId);
        return;
    }
    const svg = d3.select("#graph-container svg");
    if(svg.empty()) return;
    
    svg.selectAll(".nodes g").classed("node-dimmed", false).classed("node-highlight", false);
    svg.selectAll(".links path")
        .classed("link-dimmed", false)
        .attr("stroke", d => d.originalColor)
        .attr("opacity", d => d.opacity);
}

function filterEntityList(query) {
    const term = query.toLowerCase();
    const items = document.querySelectorAll('.entity-pill');
    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(term) ? 'flex' : 'none';
    });
}

function filterByEntity(entityName) {
    highlightEntity(entityName);
    switchGraphView('graph');
}

function switchGraphView(mode) { 
    currentViewMode = mode;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    
    // Toggle active button
    if(mode === 'graph') document.getElementById('btn-view-graph').classList.add('active');
    if(mode === 'timeline') document.getElementById('btn-view-timeline').classList.add('active');
    
    const graphEl = document.getElementById('graph-container');
    const timelineEl = document.getElementById('graph-timeline-view');
    const legend = document.getElementById('graph-legend');
    const sidebar = document.getElementById('graph-entity-sidebar');
    const resetBtn = document.getElementById('btn-reset-zoom'); 

    if(graphEl) graphEl.style.display = 'none';
    if(timelineEl) timelineEl.style.display = 'none';
    if(legend) legend.style.display = 'none';
    if(sidebar) sidebar.style.display = 'none';
    
    if (graphSimulation) graphSimulation.stop();

    if (mode === 'graph') {
        if(graphEl) graphEl.style.display = 'block'; 
        if(legend) legend.style.display = 'block'; 
        if(sidebar) sidebar.style.display = 'flex'; 
        if(resetBtn) resetBtn.style.display = 'flex'; 
        if(graphSimulation) graphSimulation.alpha(0.3).restart();
    } else {
        if(resetBtn) resetBtn.style.display = 'none'; 
        if(timelineEl) { timelineEl.style.display = 'block'; renderTimelineView(); }
    }
}

function renderTimelineView() {
    const container = document.getElementById('graph-timeline-view');
    if (!container) return;
    if (!processedNodes || processedNodes.length === 0) { 
        container.innerHTML = '<div style="color:#444; text-align:center; padding-top:100px; font-family:monospace">NO DATA STREAM</div>'; 
        return; 
    }
    const sorted = [...processedNodes].sort((a,b) => (b.date || "1970").localeCompare(a.date || "1970"));
    
    let html = `<div class="timeline-container"><div class="timeline-line"></div>`;
    let currentMonth = "";

    sorted.forEach(d => {
        const dateObj = d.date ? new Date(d.date) : null;
        let monthLabel = dateObj && !isNaN(dateObj) ? 
            `${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][dateObj.getMonth()]} ${dateObj.getFullYear()}` : 
            "UNDATED";

        if (monthLabel !== currentMonth) {
            if(currentMonth !== "") html += `</div>`; 
            html += `<div class="timeline-group"><div class="timeline-month-label" style="color:${d.color}">${monthLabel}</div>`;
            currentMonth = monthLabel;
        }

        let textContent = (typeof marked !== 'undefined') ? marked.parse(d.fullText) : d.fullText;
        let tagsHtml = d.entities ? d.entities.split(',').map(e => `<span class="meta-tag" style="color:${d.color}; border-color:${d.color}">${e.trim()}</span>`).join('') : '';

        const dStr = encodeURIComponent(JSON.stringify(d));

        html += `
        <div class="timeline-item" onclick="window.showNodeDetailsFromStr('${dStr}')">
            <div class="timeline-dot" style="border-color:${d.color}; box-shadow:0 0 5px ${d.color}"></div>
            <div class="timeline-card" style="border-color:${d.color}44">
                <div class="timeline-date-sub">${d.date ? d.date.substring(0,10) : "Unknown Date"}</div>
                <div style="font-size:0.9em; line-height:1.6; color:#ccc; font-family:'Roboto Mono', monospace">${textContent}</div>
                <div style="margin-top:12px; display:flex; gap:6px; flex-wrap:wrap">${tagsHtml}</div>
            </div>
        </div>`;
    });
    html += `</div></div>`;
    container.innerHTML = html;

    const timelineItems = container.querySelectorAll('.timeline-item');
    timelineItems.forEach((item) => {
        item.addEventListener('mouseenter', () => {
            container.classList.add('timeline-hovering');
            timelineItems.forEach((other) => other.classList.remove('timeline-item-active'));
            item.classList.add('timeline-item-active');
        });

        item.addEventListener('mouseleave', () => {
            item.classList.remove('timeline-item-active');
            if (!container.querySelector('.timeline-item-active')) {
                container.classList.remove('timeline-hovering');
            }
        });
    });
}

// --- Detail Panel Logic ---
function showNodeDetails(d) {
    const panel = document.getElementById('graph-details-panel');
    if(!panel) return;
    
    activeNodeId = d.id;
    if(currentViewMode === 'graph') applySelectionState(activeNodeId);

    panel.classList.add('open');
    document.getElementById('detail-type').innerText = d.type;
    const panelColor = d.color || COLORS.node;
    panel.style.borderLeftColor = panelColor;

    let contentHtml = (typeof marked !== 'undefined') ? marked.parse(d.fullText) : d.fullText;

    document.getElementById('detail-body').innerHTML = `
        <div class="detail-header" style="color:${panelColor}">Content</div>
        <div class="detail-content">${contentHtml}</div>
        
        <div class="detail-header" style="color:${panelColor}">Metadata</div>
        <div class="detail-meta" style="font-size:0.75em; color:#555; font-family:'Roboto Mono', monospace; margin-bottom: 20px;">
            <div style="margin-bottom: 8px;">ID: <span style="color:${panelColor}">${d.id.substring(0,8)}</span>...</div>
            <div>TAGS: <span style="color:${panelColor}">${d.entities || "N/A"}</span></div>
        </div>

        <div class="detail-actions" style="margin-top: auto; padding-top: 20px; border-top: 1px solid #1f2933;">
            <button id="btn-delete-memory" class="btn btn-delete full-width-btn" style="justify-content:center; color: #ef5350; border-color: #ef5350;">
                <span class="material-symbols-outlined" style="font-size:16px">delete</span> DELETE MEMORY
            </button>
        </div>
    `;
    
    document.getElementById('btn-delete-memory').onclick = () => deleteGraphMemory(d.id);
}

// Expose helper for timeline HTML onclick attributes
window.showNodeDetailsFromStr = (dStr) => {
    const d = JSON.parse(decodeURIComponent(dStr));
    showNodeDetails(d);
}

async function deleteGraphMemory(id) {
    if(!confirm("DELETE MEMORY? Cannot be undone.")) return;
    
    const btn = document.getElementById('btn-delete-memory');
    if(btn) btn.innerText = "DELETING...";
    
    await hindsight.deleteDocument(id);
    closeDetailPanel();
    refreshGraphData();
}

function closeDetailPanel() { 
    const panel = document.getElementById('graph-details-panel');
    if(panel) panel.classList.remove('open'); 
    activeNodeId = null; 
    if(currentViewMode === 'graph') resetHighlight(); 
}

function applySelectionState(selectedId) {
    const svg = d3.select("#graph-container svg");
    
    svg.selectAll(".nodes g").classed("node-dimmed", true).classed("node-highlight", false);
    svg.selectAll(".links path").classed("link-dimmed", true).attr("stroke", d => d.originalColor);

    const selectedNode = svg.selectAll(".nodes g").filter(n => n.id === selectedId);
    selectedNode.classed("node-dimmed", false).classed("node-highlight", true);

    svg.selectAll(".links path").filter(l => l.source.id === selectedId || l.target.id === selectedId)
        .classed("link-dimmed", false)
        .attr("stroke", COLORS.activeEdge)
        .attr("opacity", 1)
        .each(function(l) {
            const neighborId = l.source.id === selectedId ? l.target.id : l.source.id;
            svg.selectAll(".nodes g").filter(n => n.id === neighborId)
                .classed("node-dimmed", false)
                .classed("node-highlight", true);
        });
}

function dragstarted(e, d) { 
    if (!e.active) graphSimulation.alphaTarget(0.3).restart(); 
    d.fx = d.x; d.fy = d.y; 
    isDragging = true;
    wasActiveBeforeDrag = (activeNodeId === d.id);
    applySelectionState(d.id);
}

function dragged(e, d) { d.fx = e.x; d.fy = e.y; }

function dragended(e, d) { 
    if (!e.active) graphSimulation.alphaTarget(0); 
    d.fx = null; d.fy = null; 
    isDragging = false;
    if (!wasActiveBeforeDrag) {
        if (activeNodeId && activeNodeId !== d.id) applySelectionState(activeNodeId);
        else resetHighlight();
    } else {
        applySelectionState(activeNodeId);
    }
}
