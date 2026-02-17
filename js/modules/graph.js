import { hindsight } from '../services/hindsight.js';
import { sanitizeHtml } from '../core/utils.js';
import { appSettings } from '../core/store.js';

// --- State ---
let graphSimulation = null;
let graphSvg = null;
let graphZoom = null;
let graphCurrentTransform = { x: 0, y: 0, k: 1 };
let graphNodeSelection = null;
let graphLinkSelection = null;
let graphContainerEl = null;
let processedNodes = [];
let processedLinks = []; 
let activeNodeId = null; 
let isDragging = false;  
let wasActiveBeforeDrag = false;
let currentViewMode = 'graph'; 
let graphResizeBound = false;
const DEFAULT_GRAPH_SCALE = 1.25;

function applyGraphLayoutFrame() {
    if (!graphNodeSelection || !graphLinkSelection) return;

    graphLinkSelection.attr("d", (d) => {
        if (!Number.isFinite(d.source?.x) || !Number.isFinite(d.target?.x)) return "";
        return `M${d.source.x},${d.source.y} L${d.target.x},${d.target.y}`;
    });

    graphNodeSelection.attr("transform", (d) => {
        if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return "";
        return `translate(${d.x},${d.y})`;
    });
}

function stripWhenAndInvolving(raw = '') {
    return String(raw || '')
        .replace(/\s*\|\s*(when|involving)\s*:[^|\n]*/gi, '')
        .replace(/^\s*(when|involving)\s*:[^\n]*\n?/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// BATMAN / DETECTIVE PALETTE
const COLORS = {
    node: "#00bcd4",     // Ice Blue
    insight: "#ffffff",  // White
    standardLink: "#546e7a", 
    keyLink: "#ffc107",      // Amber
    activeEdge: "#ff00ff",   // Neon Pink
    bg: "#020202"
};

function getSpacingFactors() {
    const raw = Number(appSettings.graphSpacing);
    const scale = Number.isFinite(raw) ? Math.max(0.4, Math.min(2.6, raw / 100)) : 1;

    return {
        linkDistance: scale,
        keyLinkDistance: 0.9 + (scale - 1) * 0.7,
        charge: 0.75 + (scale * 0.55),
        isolateCharge: 0.85 + (scale * 0.4),
        centering: Math.max(0.35, 1.28 - (scale * 0.4)),
        collision: 0.82 + (scale * 0.34)
    };
}

function normalizeEntities(rawEntities = '') {
    return String(rawEntities || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .filter((entry) => !['none', 'null', 'n/a', 'undefined', 'unknown'].includes(entry.toLowerCase()));
}

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
                <div class="legend-item"><div class="legend-line legend-line-dashed" style="border-top-color:${COLORS.standardLink}"></div>Standard Link</div>
                <div class="legend-item"><div class="legend-line" style="background:${COLORS.activeEdge}"></div>Selected</div>
            </div>

            <div id="graph-timeline-view"></div>
            
            <div id="graph-details-panel">
                <button type="button" class="insight-btn graph-close-btn">Close</button>
                <div style="font-size:0.7em; font-weight:700; margin-bottom:10px; color:#555; text-transform:uppercase; letter-spacing:3px" id="detail-type">DATA</div>
                <div id="detail-body"></div>
            </div>
        `;
        
        // Bind events
        document.getElementById('btn-view-graph').onclick = () => switchGraphView('graph');
        document.getElementById('btn-view-timeline').onclick = () => switchGraphView('timeline');
        document.getElementById('btn-reset-zoom').onclick = resetGraphZoom;
        document.getElementById('btn-refresh-graph').onclick = refreshGraphData;
        
        const closeBtn = document.querySelector('.graph-close-btn');
        if (closeBtn) closeBtn.onclick = closeDetailPanel;
        
        document.getElementById('entity-sidebar-search').oninput = (e) => filterEntityList(e.target.value);
    }

    if (!graphResizeBound) {
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const graphPage = document.getElementById('graph-page');
                if (!graphPage || !graphPage.classList.contains('active-page')) return;
                if (currentViewMode !== 'graph') return;
                renderGraphView();
            }, 120);
        });
        graphResizeBound = true;
    }
    
    renderGraphView();
}

window.refreshGraphData = refreshGraphData;

function resetGraphZoom() {
    if (graphSvg && graphZoom) {
        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;
        const scale = DEFAULT_GRAPH_SCALE;
        const tx = (width / 2) * (1 - scale);
        const ty = (height / 2) * (1 - scale);
        const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);

        graphCurrentTransform = transform;
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
    graphContainerEl = container;
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
        const cleanedText = stripWhenAndInvolving(d.text || d.label);

        if (label.startsWith("##")) { label = "Insight"; type = "Insight"; }
        
        const entityList = normalizeEntities(d.entities || '');
        entityList.forEach((entity) => {
            entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
        });

        return { 
            id: d.id, 
            label: label.length > 20 ? label.substring(0, 17) + "..." : label, 
            fullText: cleanedText,
            type: type, 
            entities: entityList.join(', '),
            entityList,
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
        let linkOpacity = 0.35;
        let dashed = "3,3";
        let width = 1;

        const isKeyLink = type === 'causal' || type === 'entity' || type.includes('entity');
        if (isKeyLink) {
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

    // Flag disconnected nodes so we can keep them stable and in-frame.
    const degree = new Map();
    processedLinks.forEach((link) => {
        degree.set(link.source, (degree.get(link.source) || 0) + 1);
        degree.set(link.target, (degree.get(link.target) || 0) + 1);
    });
    processedNodes = processedNodes.map((node) => ({
        ...node,
        isIsolated: !degree.has(node.id)
    }));

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
    let g = null;

    if (graphSimulation) graphSimulation.stop();

    graphZoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on("zoom", (e) => {
            graphCurrentTransform = e.transform;
            if (g) g.attr("transform", e.transform);
            applyGraphLayoutFrame();
        });
    
    graphSvg = d3.select("#graph-container").append("svg")
        .attr("width", width).attr("height", height)
        .call(graphZoom)
        .on("dblclick.zoom", null);

    graphSvg.on("click", (event) => {
        if (event.target.tagName === 'svg') closeDetailPanel();
    });

    g = graphSvg.append("g");

    // Initial Zoom
    const initScale = DEFAULT_GRAPH_SCALE;
    const initialTransform = d3.zoomIdentity
        .translate((width / 2) * (1 - initScale), (height / 2) * (1 - initScale))
        .scale(initScale);
    graphCurrentTransform = initialTransform;
    graphSvg.call(graphZoom.transform, initialTransform);

    const spacing = getSpacingFactors();

    graphSimulation = d3.forceSimulation(processedNodes)
        .force("link", d3.forceLink(processedLinks).id(d => d.id).distance((l) => {
            const base = (l.type === 'causal' || l.type.includes('entity')) ? 120 : 150;
            const multiplier = (l.type === 'causal' || l.type.includes('entity'))
                ? spacing.keyLinkDistance
                : spacing.linkDistance;
            return base * multiplier;
        }).strength(0.26))
        .force("charge", d3.forceManyBody().strength((d) => {
            const base = d.isIsolated ? -120 : -360;
            return base * (d.isIsolated ? spacing.isolateCharge : spacing.charge);
        }))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("x", d3.forceX(width / 2).strength((d) => (d.isIsolated ? 0.09 : 0.02) * spacing.centering))
        .force("y", d3.forceY(height / 2).strength((d) => (d.isIsolated ? 0.09 : 0.02) * spacing.centering))
        .force("collide", d3.forceCollide().radius((d) => (d.r + 8) * spacing.collision).strength(0.4))
        .velocityDecay(0.4);

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

    graphLinkSelection = link;
    graphNodeSelection = node;

    node.append("circle")
        .attr("r", d => d.r).attr("fill", d => d.color).attr("stroke", "none");

    node.append("text").attr("dy", d => d.r + 8).attr("text-anchor", "middle")
        .text(d => d.label)
        .attr("fill", "#888") 
        .style("font-size", "4px") 
        .style("font-family", "var(--font-mono)")
        .style("pointer-events", "none").style("text-transform", "uppercase");

    graphSimulation.on("tick", () => applyGraphLayoutFrame());
    applyGraphLayoutFrame();
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
        applyGraphLayoutFrame();
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

        const rawTextContent = (typeof marked !== 'undefined') ? marked.parse(d.fullText || '') : (d.fullText || '');
        const textContent = sanitizeHtml(rawTextContent);
        const timelineEntities = normalizeEntities(d.entities || '');
        const tagsHtml = timelineEntities.length
            ? timelineEntities.map((entity) => `<span class="meta-tag" style="color:${d.color}; border-color:${d.color}">${entity}</span>`).join('')
            : '';

        html += `
        <div class="timeline-item">
            <div class="timeline-dot" style="border-color:${d.color}; box-shadow:0 0 5px ${d.color}"></div>
            <div class="timeline-card" style="border-color:${d.color}44">
                <div class="timeline-date-sub">${d.date ? d.date.substring(0,10) : "Unknown Date"}</div>
                <div style="font-size:0.9em; line-height:1.6; color:#ccc; font-family:var(--font-mono)">${textContent}</div>
                <div style="margin-top:12px; display:flex; gap:6px; flex-wrap:wrap">${tagsHtml}</div>
            </div>
        </div>`;
    });
    html += `</div></div>`;
    container.innerHTML = html;

    const timelineItems = container.querySelectorAll('.timeline-item');
    timelineItems.forEach((item, index) => {
        item.addEventListener('click', () => {
            const node = sorted[index];
            if (node) showNodeDetails(node);
        });

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
    if (currentViewMode === 'graph') {
        applyGraphLayoutFrame();
        if (graphSimulation) graphSimulation.alpha(0.16).restart();
    }
    document.getElementById('detail-type').innerText = d.type;
    const panelColor = d.color || COLORS.node;
    panel.style.borderLeftColor = panelColor;

    const rawContentHtml = (typeof marked !== 'undefined') ? marked.parse(d.fullText || '') : (d.fullText || '');
    const contentHtml = sanitizeHtml(rawContentHtml);

    document.getElementById('detail-body').innerHTML = `
        <div class="detail-header" style="color:${panelColor}">Content</div>
        <div class="detail-content">${contentHtml}</div>
        
        <div class="detail-header" style="color:${panelColor}">Metadata</div>
        <div class="detail-meta" style="font-size:0.75em; color:#555; font-family:var(--font-mono); margin-bottom: 20px;">
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
    if(currentViewMode === 'graph') {
        resetHighlight();
        applyGraphLayoutFrame();
        if (graphSimulation) graphSimulation.alpha(0.12).restart();
    }
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
