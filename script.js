// ─── Medicine catalogue ────────────────────────────────────────────────────
const MASTER_LIST = [
    "Aspirin","Amoxicillin","Atorvastatin","Azithromycin","Bisoprolol",
    "Citalopram","Clarithromycin","Clonazepam","Co-amoxiclav","Doxycycline",
    "Euthyrox","Fluoxetine","Ibuprofen","Lansoprazole","Levothyroxine",
    "Lisinopril","Losartan","Metformin","Metoprolol","Mirtazapine",
    "Nexium","Omeprazole","Pantoprazole","Paracetamol","Procombo",
    "Ramipril","Rinvoq","Sertraline","Simvastatin","Tramadol","Yasmin"
].sort();

// ─── Storage ───────────────────────────────────────────────────────────────
const STORAGE = {
    MEDS_KEY:  'medtracker_meds_v1',
    SYNC_KEY:  'medtracker_sync_v1',
    THEME_KEY: 'medtracker_theme',

    load() {
        const legacy = localStorage.getItem('meds_inventory_v15');
        if (legacy && !localStorage.getItem(this.MEDS_KEY)) {
            localStorage.setItem(this.MEDS_KEY, legacy);
            localStorage.removeItem('meds_inventory_v15');
            localStorage.removeItem('sync_time_v15');
        }
        return {
            meds:  JSON.parse(localStorage.getItem(this.MEDS_KEY)) || [],
            sync:  parseInt(localStorage.getItem(this.SYNC_KEY))   || Date.now(),
            theme: localStorage.getItem(this.THEME_KEY)            || 'system'
        };
    },

    save(meds, syncTime) {
        localStorage.setItem(this.MEDS_KEY, JSON.stringify(meds));
        localStorage.setItem(this.SYNC_KEY, syncTime);
    },

    saveTheme(t) { localStorage.setItem(this.THEME_KEY, t); }
};

// ─── App ───────────────────────────────────────────────────────────────────
const App = {
    activeMeds: [],
    lastSync:   Date.now(),
    history:    null,
    isEditMode: false,
    pendingAction: null,
    theme: 'system',
    _sliderListeners: [],
    _toastTimer: null,

    init() {
        const stored = STORAGE.load();
        this.activeMeds = stored.meds;
        this.lastSync   = stored.sync;
        this.theme      = stored.theme;

        this.cacheDOM();
        this.applyTheme();
        this.populateSelector();
        this.syncStock();
        this.bindEvents();
        this.render();
        this.updateSyncLabel();
        this.registerSW();

        window.matchMedia('(prefers-color-scheme: dark)')
              .addEventListener('change', () => {
                  if (this.theme === 'system') this.applyTheme();
              });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.syncStock();
                this.render();
                this.updateSyncLabel();
            }
        });
    },

    cacheDOM() {
        this.listEl     = document.getElementById('med-list');
        this.toastEl    = document.getElementById('undo-toast');
        this.selectorEl = document.getElementById('med-selector');
        this.editBtn    = document.getElementById('edit-mode-btn');
        this.modal      = document.getElementById('refill-modal');
        this.modalBody  = document.getElementById('modal-body');
        this.syncLabel  = document.getElementById('sync-display');
        this.themeBtn   = document.getElementById('theme-btn');
        this.editModal  = document.getElementById('edit-modal');
    },

    // ── Theme ────────────────────────────────────────────────────────────────
    applyTheme() {
        const sys    = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark = this.theme === 'dark' || (this.theme === 'system' && sys);
        document.documentElement.classList.toggle('dark', isDark);
        if (this.themeBtn) {
            this.themeBtn.textContent = isDark ? '☀️' : '🌙';
            this.themeBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
        }
    },

    toggleTheme() {
        const dark = document.documentElement.classList.contains('dark');
        this.theme = dark ? 'light' : 'dark';
        STORAGE.saveTheme(this.theme);
        this.applyTheme();
        this.haptic('light');
    },

    // ── Sync label ────────────────────────────────────────────────────────────
    updateSyncLabel() {
        const diff = Date.now() - this.lastSync;
        const mins = Math.floor(diff / 60_000);
        const hrs  = Math.floor(diff / 3_600_000);
        const label = mins < 1  ? 'Synced just now'
                    : mins < 60 ? `Synced ${mins}m ago`
                    : hrs  < 24 ? `Synced ${hrs}h ago`
                    :             `Synced ${Math.floor(hrs/24)}d ago`;
        if (this.syncLabel) this.syncLabel.textContent = label;
    },

    // ── SW & notifications ───────────────────────────────────────────────────
    registerSW() {
        if (!('serviceWorker' in navigator)) return;

        navigator.serviceWorker.register('sw.js').then(async reg => {
            // Register Periodic Background Sync (needs PWA install + notification permission)
            if ('periodicSync' in reg) {
                try {
                    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
                    if (status.state === 'granted') {
                        await reg.periodicSync.register('daily-stock-deduction', {
                            minInterval: 24 * 60 * 60 * 1000
                        });
                        console.log('[MedTracker] Periodic background sync registered.');
                    }
                } catch (e) {
                    console.warn('[MedTracker] Periodic sync unavailable:', e);
                }
            }
        }).catch(e => console.warn('[MedTracker] SW failed:', e));

        // When SW deducts in background, reload open tab data
        navigator.serviceWorker.addEventListener('message', e => {
            if (e.data?.type === 'BG_SYNC_COMPLETE') {
                const stored = STORAGE.load();
                this.activeMeds = stored.meds;
                this.lastSync   = stored.sync;
                this.render();
                this.updateSyncLabel();
                this.showToast('Stock updated in background', false);
            }
        });

        const btn = document.getElementById('notif-btn');
        const syncBtnState = () => {
            if (!('Notification' in window)) return;
            btn.classList.toggle('notif-on',  Notification.permission === 'granted');
            btn.classList.toggle('notif-off', Notification.permission === 'denied');
        };
        syncBtnState();

        btn.addEventListener('click', async () => {
            if (!('Notification' in window)) {
                this.showToast('Notifications not supported on this device.', false); return;
            }
            if (Notification.permission === 'denied') {
                this.showToast('Notifications blocked — enable in browser settings.', false); return;
            }
            const result = await Notification.requestPermission();
            syncBtnState();
            if (result === 'granted') {
                // Attempt periodic sync registration now that we have permission
                navigator.serviceWorker.ready.then(async reg => {
                    if ('periodicSync' in reg) {
                        try {
                            await reg.periodicSync.register('daily-stock-deduction', {
                                minInterval: 24 * 60 * 60 * 1000
                            });
                            this.showToast('Background sync enabled ✓', false);
                        } catch(e) {
                            // Not yet installed as PWA — will register on install
                        }
                    }
                });
                this.checkLowStockAlerts();
            }
        });
    },

    checkLowStockAlerts() {
        if (Notification.permission !== 'granted') return;
        navigator.serviceWorker.ready.then(reg => {
            this.activeMeds.forEach(m => {
                if (m.stock > 0 && m.stock <= (m.threshold || 0))
                    reg.active?.postMessage({ type:'LOW_STOCK_ALERT', payload:{ name:m.name, stock:m.stock } });
            });
        });
    },

    // ── 24-hour sync ─────────────────────────────────────────────────────────
    syncStock() {
        const days = Math.floor((Date.now() - this.lastSync) / 86_400_000);
        if (days < 1) return;
        this.activeMeds = this.activeMeds.map(m => {
            for (let i = 0; i < days; i++) {
                const amt = m.pattern ? m.pattern[m.patternIdx % m.pattern.length] : (m.frequency || 0);
                m.stock = Math.max(0, m.stock - amt);
                if (m.pattern) {
                    m.patternIdx = (m.patternIdx + 1) % m.pattern.length;
                    m.takeAmount = m.pattern[m.patternIdx];
                }
            }
            return m;
        });
        this.lastSync += days * 86_400_000;
        this.save();
    },

    haptic(type = 'light') {
        if (!navigator.vibrate) return;
        ({ light:()=>navigator.vibrate(10), medium:()=>navigator.vibrate(30), success:()=>navigator.vibrate([20,30,20]) }[type]||(() =>{}))();
    },

    populateSelector() {
        MASTER_LIST.forEach(name => {
            const o = document.createElement('option');
            o.value = name; o.textContent = name;
            this.selectorEl.appendChild(o);
        });
    },

    // ── Events ───────────────────────────────────────────────────────────────
    bindEvents() {
        document.getElementById('add-track-btn').onclick = () => this.addNewMed();
        this.themeBtn.onclick  = () => this.toggleTheme();

        this.editBtn.onclick = () => {
            this.isEditMode = !this.isEditMode;
            document.body.classList.toggle('edit-active', this.isEditMode);
            this.editBtn.classList.toggle('active', this.isEditMode);
            this.haptic('medium');
            this.editBtn.style.opacity = '0';
            setTimeout(() => {
                this.editBtn.innerText = this.isEditMode ? 'Done' : 'Edit';
                this.editBtn.style.opacity = '1';
                this.render();
            }, 150);
        };

        document.getElementById('modal-add').onclick     = () => this.confirmRefill('add');
        document.getElementById('modal-replace').onclick = () => this.confirmRefill('replace');
        document.getElementById('modal-cancel').onclick  = () => this.modal.classList.remove('active');

        // Edit modal
        document.getElementById('edit-save-btn').onclick   = () => this.saveEdit();
        document.getElementById('edit-cancel-btn').onclick = () => this.editModal.classList.remove('active');


    },

    // ── Frequency parser ─────────────────────────────────────────────────────
    parseFrequency(val) {
        const s = val.toString().trim();
        if (!s) return { frequency:0, pattern:null, valid:false };
        if (s.includes('-')) {
            const parts = s.split('-').map(Number);
            const ok = parts.length >= 2 && parts.every(n => Number.isInteger(n) && n > 0);
            return ok ? { frequency:parts[0], pattern:parts, valid:true }
                      : { frequency:0, pattern:null, valid:false };
        }
        const n = parseInt(s);
        return (!isNaN(n) && n > 0) ? { frequency:n, pattern:null, valid:true }
                                    : { frequency:0, pattern:null, valid:false };
    },

    shake(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('shake'); void el.offsetWidth;
        el.classList.add('shake'); el.focus();
    },

    // ── Add medicine ─────────────────────────────────────────────────────────
    addNewMed() {
        const name  = document.getElementById('custom-name').value.trim() || this.selectorEl.value;
        const stock = parseInt(document.getElementById('new-stock').value);
        const freq  = document.getElementById('new-freq').value;

        if (!name)                    return this.shake('custom-name');
        if (isNaN(stock)||stock < 0)  return this.shake('new-stock');

        const { frequency, pattern, valid } = this.parseFrequency(freq);
        if (!valid) return this.shake('new-freq');

        const existing = this.activeMeds.find(m => m.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            this.pendingAction = { existing, stock, frequency, pattern };
            this.modalBody.innerHTML = `<strong>${existing.name}</strong> is already tracked with <strong>${existing.stock}</strong> units remaining. How would you like to proceed?`;
            this.modal.classList.add('active');
        } else {
            this.activeMeds.push({
                id:Date.now(), name, stock, maxStock:stock,
                frequency, pattern, patternIdx:0,
                threshold:Math.max(1, Math.floor(stock*0.1)),
                takeAmount:frequency||1, doseLog:[]
            });
            this.haptic('medium');
            this.finalize();
        }
    },

    confirmRefill(type) {
        const { existing, stock, frequency, pattern } = this.pendingAction;
        if (type==='add') existing.stock += stock; else existing.stock = stock;
        existing.maxStock   = Math.max(existing.maxStock||0, existing.stock);
        existing.frequency  = frequency; existing.pattern = pattern;
        existing.patternIdx = 0; existing.takeAmount = frequency||1;
        existing.threshold  = Math.max(1, Math.floor(existing.stock*0.1));
        if (!existing.doseLog) existing.doseLog = [];
        this.modal.classList.remove('active');
        this.haptic('success'); this.finalize();
    },

    finalize() {
        ['custom-name','new-stock','new-freq'].forEach(id => { document.getElementById(id).value=''; });
        this.selectorEl.value = '';
        this.save(); this.render(); this.checkLowStockAlerts();
    },

    // ── Inline edit ──────────────────────────────────────────────────────────
    openEdit(id) {
        const med = this.activeMeds.find(m => m.id === id);
        if (!med) return;
        document.getElementById('edit-id').value    = id;
        document.getElementById('edit-name').value  = med.name;
        document.getElementById('edit-stock').value = med.stock;
        document.getElementById('edit-freq').value  = med.pattern ? med.pattern.join('-') : med.frequency;
        this.editModal.classList.add('active');
    },

    saveEdit() {
        const id    = parseInt(document.getElementById('edit-id').value);
        const name  = document.getElementById('edit-name').value.trim();
        const stock = parseInt(document.getElementById('edit-stock').value);
        const freq  = document.getElementById('edit-freq').value;

        if (!name || isNaN(stock) || stock < 0) return;
        const { frequency, pattern, valid } = this.parseFrequency(freq);
        if (!valid) return;

        const med = this.activeMeds.find(m => m.id === id);
        if (!med) return;
        med.name      = name;
        med.stock     = stock;
        med.maxStock  = Math.max(med.maxStock||0, stock);
        med.frequency = frequency;
        med.pattern   = pattern;
        med.patternIdx= 0;
        med.takeAmount= frequency||1;
        med.threshold = Math.max(1, Math.floor(stock*0.1));

        this.editModal.classList.remove('active');
        this.haptic('success'); this.save(); this.render();
    },

    // ── Dose taken today? ─────────────────────────────────────────────────────
    takenToday(med) {
        if (!med.doseLog || med.doseLog.length === 0) return false;
        const last = med.doseLog[med.doseLog.length - 1];
        const today = new Date().toDateString();
        return new Date(last.ts).toDateString() === today;
    },

    // ── Sorting ───────────────────────────────────────────────────────────────
    sortedMeds() {
        return [...this.activeMeds].sort((a,b) => {
            const rank = m => m.stock<=0 ? 0 : m.stock<=(m.threshold||0) ? 1 : 2;
            const d = rank(a)-rank(b);
            return d !== 0 ? d : a.name.localeCompare(b.name);
        });
    },

    // ── Render ────────────────────────────────────────────────────────────────
    render() {
        this._removeSliderListeners();

        if (this.activeMeds.length === 0) {
            this.listEl.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">💊</div>
                    <p class="empty-title">No medications tracked</p>
                    <p class="empty-sub">Add your first medication above to get started.</p>
                </div>`;
            return;
        }

        this.listEl.innerHTML = this.sortedMeds().map(m => {
            const isEmpty   = m.stock <= 0;
            const maxS      = m.maxStock || m.stock || 1;
            const barPct    = isEmpty ? 0 : Math.min(100, Math.max(1, Math.round((m.stock/maxS)*100)));
            const barClass  = barPct>50 ? 'bar-green' : barPct>10 ? 'bar-yellow' : 'bar-red';
            const colorClass= isEmpty ? 'status-empty' : barPct>50 ? 'status-high' : barPct>10 ? 'status-med' : 'status-low';

            const avgDaily  = m.pattern ? m.pattern.reduce((a,b)=>a+b,0)/m.pattern.length : (m.frequency||1);
            const daysLeft  = isEmpty ? 0 : Math.floor(m.stock/avgDaily);
            const refillDate= new Date(Date.now()+daysLeft*86_400_000);
            const dateStr   = refillDate.toLocaleDateString(undefined,{month:'short',day:'numeric'});
            const supplyLabel = isEmpty ? 'Out of stock' : `${daysLeft}d · Refill by ${dateStr}`;

            const freqDisplay = m.pattern ? m.pattern.join('–') : m.frequency;
            const cycle       = m.pattern ? `<span class="cycle-tag">${m.pattern.join('-')}</span>` : '';
            const takenToday  = this.takenToday(m);

            // Last 5 dose log entries — collapsible, collapsed by default
            const log = (m.doseLog||[]).slice(-5).reverse();
            const logHTML = log.length ? `
                <div class="dose-log">
                    <button class="dose-log-toggle" onclick="App.toggleLog(this)" aria-expanded="false">
                        <span>Extra doses taken (${log.length})</span>
                        <svg class="toggle-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>
                    <div class="dose-log-body" hidden>
                        ${log.map(e => {
                            const d = new Date(e.ts);
                            const dateLabel = d.toDateString()===new Date().toDateString() ? 'Today' : d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
                            const time = d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
                            return `<div class="dose-log-row"><span class="dose-log-time">${dateLabel} · ${time}</span><span class="dose-log-amt">${e.amount} unit${e.amount>1?'s':''}</span></div>`;
                        }).join('')}
                    </div>
                </div>` : '';

            return `
            <div class="med-card ${isEmpty?'is-empty':''} ${takenToday?'taken-today':''}">
                <div class="del-badge" onclick="App.deleteMed(${m.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </div>
                <div class="edit-badge" onclick="App.openEdit(${m.id})">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </div>

                <div class="card-header">
                    <div class="card-title-row">
                        <div class="med-name">${m.name}${cycle}</div>
                        ${takenToday ? '<div class="taken-badge">✓ Taken today</div>' : ''}
                    </div>
                    <div class="med-meta">
                        <span class="${colorClass}">${isEmpty ? 'Out of stock' : `${m.stock} units`}</span>
                        <span class="stat-sep">·</span>
                        <span class="daily-label">${freqDisplay}/day</span>
                    </div>
                    <div class="supply-bar-track">
                        <div class="supply-bar-fill ${barClass}" style="width:${barPct}%"></div>
                    </div>
                    <div class="supply-label ${colorClass}">${supplyLabel}</div>
                </div>

                <div class="action-area">
                    <div class="stepper">
                        <button onclick="App.adjStep(${m.id},-1)" aria-label="Decrease">−</button>
                        <span id="step-${m.id}">Take ${m.takeAmount}</span>
                        <button onclick="App.adjStep(${m.id},1)" aria-label="Increase">+</button>
                    </div>
                    <div class="slide-container" id="container-${m.id}">
                        <div class="slide-text">Slide to confirm</div>
                        <div class="slide-track" id="track-${m.id}"></div>
                        <div class="slide-handle" id="handle-${m.id}">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>
                        </div>
                    </div>
                </div>

                ${logHTML}
            </div>`;
        }).join('');

        this.activeMeds.forEach(m => this.initSlider(m.id));
    },

    adjStep(id, delta) {
        if (this.isEditMode) return;
        const med = this.activeMeds.find(m => m.id===id);
        if (!med) return;
        med.takeAmount = Math.max(1, (med.takeAmount||1)+delta);
        this.haptic('light');
        const el = document.getElementById(`step-${id}`);
        if (el) el.textContent = `Take ${med.takeAmount}`;
        this.save();
    },

    handleTake(id) {
        this.history = JSON.stringify(this.activeMeds);
        this.activeMeds = this.activeMeds.map(m => {
            if (m.id===id) {
                const amount = m.takeAmount||1;
                m.stock = Math.max(0, m.stock - amount);
                if (!m.doseLog) m.doseLog = [];
                m.doseLog.push({ ts: Date.now(), amount });
                // Keep log trimmed to 30 entries max
                if (m.doseLog.length > 30) m.doseLog = m.doseLog.slice(-30);
                if (m.pattern) {
                    m.patternIdx = (m.patternIdx+1) % m.pattern.length;
                    m.takeAmount = m.pattern[m.patternIdx];
                }
            }
            return m;
        });
        this.haptic('success'); this.save(); this.render();
        this.showToast('Dose recorded', true);
        this.checkLowStockAlerts();
    },

    undo() {
        if (!this.history) return;
        this.activeMeds = JSON.parse(this.history);
        this.history = null;
        this.haptic('medium'); this.save(); this.render();
        this.toastEl.classList.remove('active');
    },

    showToast(msg, withUndo=false) {
        this.toastEl.querySelector('.toast-msg').textContent = msg;
        this.toastEl.querySelector('.toast-undo').style.display = withUndo ? 'inline' : 'none';
        this.toastEl.classList.add('active');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(()=>this.toastEl.classList.remove('active'), 4000);
    },

    toggleLog(btn) {
        const body     = btn.nextElementSibling;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', !expanded);
        body.hidden = expanded;
        btn.querySelector('.toggle-chevron').style.transform = expanded ? '' : 'rotate(180deg)';
    },

    // ── Slider ───────────────────────────────────────────────────────────────
    initSlider(id) {
        const handle    = document.getElementById(`handle-${id}`);
        const container = document.getElementById(`container-${id}`);
        const track     = document.getElementById(`track-${id}`);
        if (!handle) return;
        let dragging = false;
        const getMax = () => container.offsetWidth - handle.offsetWidth - 10;
        const onStart = () => { if (!this.isEditMode) dragging = true; };
        const onMove  = e => {
            if (!dragging) return;
            const cx  = e.touches ? e.touches[0].clientX : e.clientX;
            const pos = Math.max(0, Math.min(cx - container.getBoundingClientRect().left - 24, getMax()));
            handle.style.left = `${pos+5}px`; track.style.width = `${pos+24}px`;
            if (pos >= getMax()) { dragging=false; this.handleTake(id); }
        };
        const onEnd = () => { dragging=false; handle.style.left='5px'; track.style.width='0'; };
        handle.addEventListener('mousedown', onStart);
        handle.addEventListener('touchstart', onStart, {passive:true});
        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, {passive:true});
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchend', onEnd);
        this._sliderListeners.push({handle,onStart,onMove,onEnd});
    },

    _removeSliderListeners() {
        this._sliderListeners.forEach(({handle,onStart,onMove,onEnd}) => {
            handle.removeEventListener('mousedown', onStart);
            handle.removeEventListener('touchstart', onStart);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('mouseup', onEnd);
            window.removeEventListener('touchend', onEnd);
        });
        this._sliderListeners = [];
    },

    // ── Delete (double-tap) ───────────────────────────────────────────────────
    deleteMed(id) {
        const badge = document.querySelector(`.del-badge[onclick="App.deleteMed(${id})"]`);
        const card  = badge?.closest('.med-card');
        if (!card) return;
        if (card.dataset.confirmDelete==='true') {
            this.activeMeds = this.activeMeds.filter(m=>m.id!==id);
            this.save(); this.render();
        } else {
            card.dataset.confirmDelete='true';
            badge.classList.add('confirm');
            setTimeout(()=>{ if(card.dataset.confirmDelete==='true'){card.dataset.confirmDelete='false';badge.classList.remove('confirm');} },2500);
        }
    },

    save() {
        STORAGE.save(this.activeMeds, this.lastSync);
        // Mirror data to IndexedDB so the SW can read it during background sync
        // (SW scope cannot access localStorage)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.ready.then(reg => {
                reg.active?.postMessage({
                    type:     'PERSIST_TO_IDB',
                    meds:     this.activeMeds,
                    syncTime: this.lastSync
                });
            });
        }
    }
};

App.init();
