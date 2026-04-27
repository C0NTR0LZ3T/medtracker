// MASTER_LIST is loaded from medicines.js (loaded before this script in index.html)

// ─── Storage ───────────────────────────────────────────────────────────────
const STORAGE = {
    MEDS_KEY:    'medtracker_meds_v1',
    SYNC_KEY:    'medtracker_sync_v1',
    THEME_KEY:   'medtracker_theme',
    ONBOARD_KEY: 'medtracker_onboarded',

    load() {
        const legacy = localStorage.getItem('meds_inventory_v15');
        if (legacy && !localStorage.getItem(this.MEDS_KEY)) {
            localStorage.setItem(this.MEDS_KEY, legacy);
            localStorage.removeItem('meds_inventory_v15');
            localStorage.removeItem('sync_time_v15');
        }
        return {
            meds:      JSON.parse(localStorage.getItem(this.MEDS_KEY)) || [],
            sync:      parseInt(localStorage.getItem(this.SYNC_KEY))   || Date.now(),
            theme:     localStorage.getItem(this.THEME_KEY)            || 'system',
            onboarded: !!localStorage.getItem(this.ONBOARD_KEY)
        };
    },

    save(meds, syncTime) {
        localStorage.setItem(this.MEDS_KEY, JSON.stringify(meds));
        localStorage.setItem(this.SYNC_KEY, syncTime);
    },

    saveTheme(t)   { localStorage.setItem(this.THEME_KEY, t); },
    setOnboarded() { localStorage.setItem(this.ONBOARD_KEY, '1'); }
};

// ─── App ───────────────────────────────────────────────────────────────────
const App = {
    activeMeds:    [],
    lastSync:      Date.now(),
    history:       null,
    isEditMode:    false,
    pendingAction: null,
    theme:         'system',
    _toastTimer:   null,

    init() {
        const stored = STORAGE.load();
        this.activeMeds = stored.meds;
        this.lastSync   = stored.sync;
        this.theme      = stored.theme;

        this.cacheDOM();
        this.applyTheme();
        if (!stored.onboarded) this.showOnboarding();
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
        this.listEl      = document.getElementById('med-list');
        this.toastEl     = document.getElementById('undo-toast');
        this.selectorEl  = document.getElementById('med-selector');
        this.editBtn     = document.getElementById('edit-mode-btn');
        this.modal       = document.getElementById('refill-modal');
        this.modalBody   = document.getElementById('modal-body');
        this.syncLabel   = document.getElementById('sync-display');
        this.themeBtn    = document.getElementById('theme-btn');
        this.editModal   = document.getElementById('edit-modal');
        this.onboarding  = document.getElementById('onboarding');
        this.extraModal  = document.getElementById('extra-dose-modal');
    },

    // ── Onboarding ────────────────────────────────────────────────────────────
    showOnboarding()    { this.onboarding?.classList.add('active'); },
    dismissOnboarding() { this.onboarding?.classList.remove('active'); STORAGE.setOnboarded(); },

    // ── Theme ─────────────────────────────────────────────────────────────────
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
        this.theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
        STORAGE.saveTheme(this.theme);
        this.applyTheme();
        this.haptic('light');
    },

    // ── Sync label ────────────────────────────────────────────────────────────
    updateSyncLabel() {
        const diff  = Date.now() - this.lastSync;
        const mins  = Math.floor(diff / 60_000);
        const hrs   = Math.floor(diff / 3_600_000);
        const label = mins < 1  ? 'Synced just now'
                    : mins < 60 ? `Synced ${mins}m ago`
                    : hrs  < 24 ? `Synced ${hrs}h ago`
                    :             `Synced ${Math.floor(hrs/24)}d ago`;
        if (this.syncLabel) this.syncLabel.textContent = label;
    },

    // ── SW & notifications ────────────────────────────────────────────────────
    registerSW() {
        if (!('serviceWorker' in navigator)) return;

        navigator.serviceWorker.register('sw.js').then(async reg => {
            if ('periodicSync' in reg) {
                try {
                    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
                    if (status.state === 'granted') {
                        await reg.periodicSync.register('daily-stock-deduction', {
                            minInterval: 24 * 60 * 60 * 1000
                        });
                    }
                } catch(e) { /* unavailable */ }
            }
        }).catch(e => console.warn('[MedTracker] SW failed:', e));

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
        const syncBtn = () => {
            if (!('Notification' in window)) return;
            btn.classList.toggle('notif-on',  Notification.permission === 'granted');
            btn.classList.toggle('notif-off', Notification.permission === 'denied');
        };
        syncBtn();

        btn.addEventListener('click', async () => {
            if (!('Notification' in window))        { this.showToast('Notifications not supported.', false); return; }
            if (Notification.permission === 'denied') { this.showToast('Notifications blocked — enable in browser settings.', false); return; }
            const result = await Notification.requestPermission();
            syncBtn();
            if (result === 'granted') {
                navigator.serviceWorker.ready.then(async reg => {
                    if ('periodicSync' in reg) {
                        try {
                            await reg.periodicSync.register('daily-stock-deduction', { minInterval: 24*60*60*1000 });
                            this.showToast('Background sync enabled ✓', false);
                        } catch(e) { /* needs PWA install */ }
                    }
                });
                this.checkLowStockAlerts();
                this.scheduleRefillReminders();
            }
        });
    },

    // ── Notification helper — waits for SW active state reliably ────────────
    async _sendNotification(title, body, tag) {
        if (Notification.permission !== 'granted') return;
        if (!('serviceWorker' in navigator)) return;
        try {
            const reg = await navigator.serviceWorker.ready;
            // Wait until there is an active SW — poll briefly if needed
            let sw = reg.active;
            if (!sw) {
                await new Promise(r => setTimeout(r, 500));
                sw = reg.active;
            }
            if (sw) {
                sw.postMessage({ type: 'SHOW_NOTIFICATION', title, body, tag });
            } else {
                reg.showNotification(title, { body, tag, icon: 'icon.png' });
            }
        } catch(e) {
            console.warn('[MedTracker] Notification failed:', e);
        }
    },

    checkLowStockAlerts() {
        this.activeMeds.forEach(m => {
            if (m.stock <= 0) {
                this._sendNotification(
                    '🚨 Out of Stock',
                    `${m.name} has run out. Time to refill.`,
                    'empty-' + m.name
                );
            } else if (m.stock <= (m.threshold || 0)) {
                this._sendNotification(
                    '⚠️ Low Stock Alert',
                    `${m.name} is running low — only ${m.stock} unit${m.stock !== 1 ? 's' : ''} left.`,
                    'low-' + m.name
                );
            }
        });
    },

    scheduleRefillReminders() {
        this.activeMeds.forEach(m => {
            if (m.stock <= 0) return;
            const avg      = m.pattern ? m.pattern.reduce((a,b)=>a+b,0)/m.pattern.length : (m.frequency||1);
            const daysLeft = Math.floor(m.stock / avg);
            if (daysLeft === 7 || daysLeft === 3) {
                this._sendNotification(
                    '🗓 Refill Reminder',
                    `${m.name} will run out in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Time to reorder.`,
                    'refill-' + m.name
                );
            }
        });
    },

    // ── 24-hour sync ──────────────────────────────────────────────────────────
    syncStock() {
        const days = Math.floor((Date.now() - this.lastSync) / 86_400_000);
        if (days < 1) return;
        this.activeMeds = this.activeMeds.map(m => {
            for (let i = 0; i < days; i++) {
                const amt = m.pattern ? m.pattern[m.patternIdx % m.pattern.length] : (m.frequency || 0);
                m.stock = Math.max(0, m.stock - amt);
                if (m.pattern) {
                    m.patternIdx = (m.patternIdx+1) % m.pattern.length;
                    m.takeAmount = m.pattern[m.patternIdx];
                }
            }
            return m;
        });
        this.lastSync += days * 86_400_000;
        this.save();
        this.scheduleRefillReminders();
    },

    haptic(type='light') {
        if (!navigator.vibrate) return;
        ({light:()=>navigator.vibrate(10), medium:()=>navigator.vibrate(30), success:()=>navigator.vibrate([20,30,20])}[type]||(() =>{}))();
    },

    populateSelector() {
        MASTER_LIST.forEach(name => {
            const o = document.createElement('option');
            o.value = name; o.textContent = name;
            this.selectorEl.appendChild(o);
        });
    },

    // ── Events ────────────────────────────────────────────────────────────────
    bindEvents() {
        document.getElementById('add-track-btn').onclick = () => this.addNewMed();
        this.themeBtn.onclick = () => this.toggleTheme();
        document.getElementById('onboard-btn').onclick = () => this.dismissOnboarding();

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
        document.getElementById('modal-cancel').onclick  = () => { this.modal.classList.remove('active'); const mf=document.getElementById('modal-freq'); if(mf) mf.value=''; };

        document.getElementById('edit-save-btn').onclick   = () => this.saveEdit();
        document.getElementById('edit-cancel-btn').onclick = () => this.editModal.classList.remove('active');

        // Quick refill modal
        document.getElementById('refill2-minus').onclick   = () => this.adjustRefillQty(-1);
        document.getElementById('refill2-plus').onclick    = () => this.adjustRefillQty(1);
        document.getElementById('refill2-add').onclick     = () => this.confirmQuickRefill('add');
        document.getElementById('refill2-replace').onclick = () => this.confirmQuickRefill('replace');
        document.getElementById('refill2-cancel').onclick  = () => document.getElementById('refill-modal-2').classList.remove('active');

        // Extra dose modal (fallback — buttons only exist if modal is open)
        const extraConfirm = document.getElementById('extra-confirm-btn');
        const extraCancel  = document.getElementById('extra-cancel-btn');
        if (extraConfirm) extraConfirm.onclick = () => this.confirmExtraDose();
        if (extraCancel)  extraCancel.onclick  = () => this.extraModal?.classList.remove('active');
    },

    // ── Frequency parser ──────────────────────────────────────────────────────
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

    // ── Add medicine ──────────────────────────────────────────────────────────
    addNewMed() {
        const name  = document.getElementById('custom-name').value.trim() || this.selectorEl.value;
        const stock = parseInt(document.getElementById('new-stock').value);
        const freq  = document.getElementById('new-freq').value;

        if (!name)                   return this.shake('custom-name');
        if (isNaN(stock)||stock < 0) return this.shake('new-stock');

        const { frequency, pattern, valid } = this.parseFrequency(freq);
        if (!valid) return this.shake('new-freq');

        const existing = this.activeMeds.find(m => m.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            this.pendingAction = { existing, stock, frequency, pattern };
            this.modalBody.innerHTML = `<strong>${existing.name}</strong> is already tracked with <strong>${existing.stock}</strong> units remaining. How would you like to proceed?`;
            this.modal.classList.add('active');
        } else {
            this.activeMeds.push({
                id: Date.now(), name, stock, maxStock: stock,  // maxStock = initial bottle size
                frequency, pattern, patternIdx: 0,
                threshold: Math.max(1, Math.floor(stock*0.1)),
                takeAmount: frequency||1, doseLog: [],
                order: this.activeMeds.length
            });
            this.haptic('medium');
            this.finalize();
        }
    },

    confirmRefill(type) {
        const { existing, stock, frequency, pattern } = this.pendingAction;
        if (type==='add') {
            existing.stock   += stock;
            existing.maxStock = existing.stock;
        } else {
            existing.stock    = stock;
            existing.maxStock = stock;
        }

        // Check if user entered a new dose in the modal field
        const freqVal = document.getElementById('modal-freq')?.value.trim();
        if (freqVal) {
            const { frequency: newFreq, pattern: newPat, valid } = this.parseFrequency(freqVal);
            if (valid) {
                existing.frequency  = newFreq;
                existing.pattern    = newPat;
                existing.patternIdx = 0;
                existing.takeAmount = newFreq || 1;
            } else {
                // Fall back to the dose from pendingAction
                existing.frequency  = frequency;
                existing.pattern    = pattern;
                existing.patternIdx = 0;
                existing.takeAmount = frequency || 1;
            }
        } else {
            // Blank = keep existing dose unchanged
            // (don't overwrite with pendingAction values which may be stale)
        }

        existing.threshold = Math.max(1, Math.floor(existing.stock * 0.1));
        if (!existing.doseLog) existing.doseLog = [];
        this.modal.classList.remove('active');
        // Clear the dose field for next time
        if (document.getElementById('modal-freq')) document.getElementById('modal-freq').value = '';
        this.haptic('success'); this.finalize();
    },

    // ── Quick refill from card (#2) ───────────────────────────────────────────
    quickRefill(id) {
        const med = this.activeMeds.find(m => m.id === id);
        if (!med) return;
        const suggested = med.maxStock || 30;
        document.getElementById('refill-med-id').value        = id;
        document.getElementById('refill-qty').textContent     = suggested;
        document.getElementById('refill-med-name').textContent= med.name;
        document.getElementById('refill-current').textContent = `Current stock: ${med.stock} ${med.stock===1?'unit':'units'}`;
        // Pre-fill dose with current value so user sees what it is
        const curFreq = med.pattern ? med.pattern.join('-') : (med.frequency || '');
        document.getElementById('refill2-freq').value = curFreq;
        document.getElementById('refill-modal-2').classList.add('active');
    },

    adjustRefillQty(delta) {
        const el  = document.getElementById('refill-qty');
        const cur = parseInt(el.textContent) || 1;
        el.textContent = Math.max(1, cur + delta);
    },

    confirmQuickRefill(type) {
        const id    = parseInt(document.getElementById('refill-med-id').value);
        const qty   = parseInt(document.getElementById('refill-qty').textContent) || 1;
        const freqVal = document.getElementById('refill2-freq').value.trim();
        const med   = this.activeMeds.find(m => m.id === id);
        if (!med) return;

        if (type === 'add') {
            med.stock    += qty;
            med.maxStock  = med.stock;
        } else {
            med.stock     = qty;
            med.maxStock  = qty;
        }
        med.threshold = Math.max(1, Math.floor(med.stock * 0.1));

        // Apply new dose only if user entered something valid
        if (freqVal) {
            const { frequency, pattern, valid } = this.parseFrequency(freqVal);
            if (valid) {
                med.frequency  = frequency;
                med.pattern    = pattern;
                med.patternIdx = 0;
                med.takeAmount = frequency || 1;
            }
        }

        document.getElementById('refill-modal-2').classList.remove('active');
        this.haptic('success');
        this.save(); this.render(); this.checkLowStockAlerts();
        this.showToast(`${med.name} restocked to ${med.stock} ${med.stock===1?'unit':'units'}`, false);
    },

    finalize() {
        ['custom-name','new-stock','new-freq'].forEach(id => { document.getElementById(id).value=''; });
        this.selectorEl.value = '';
        this.save(); this.render(); this.checkLowStockAlerts();
    },

    // ── Inline edit ───────────────────────────────────────────────────────────
    openEdit(id) {
        const med = this.activeMeds.find(m => m.id===id);
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
        const med = this.activeMeds.find(m => m.id===id);
        if (!med) return;
        med.name=name; med.stock=stock;
        // Only raise maxStock, never lower it via edit — refill flow handles that
        med.maxStock   = Math.max(med.maxStock || 0, stock);
        med.frequency  = frequency; med.pattern = pattern;
        med.patternIdx = 0; med.takeAmount = frequency||1;
        med.threshold  = Math.max(1, Math.floor(stock*0.1));
        this.editModal.classList.remove('active');
        this.haptic('success'); this.save(); this.render();
    },

    // ── Extra dose slider ─────────────────────────────────────────────────────
    // openExtraDose / _initExtraSlider — kept for compatibility but extra doses
    // are now handled inline per-card via initCardSliders() / _recordExtraDose().
    openExtraDose(id) {
        // Delegate to card-based flow — just a no-op stub now.
    },

    // ── Taken today? ──────────────────────────────────────────────────────────
    takenToday(med) {
        if (!med.doseLog?.length) return false;
        return new Date(med.doseLog[med.doseLog.length-1].ts).toDateString() === new Date().toDateString();
    },

    // ── Sorting ───────────────────────────────────────────────────────────────
    sortedMeds() {
        return [...this.activeMeds].sort((a,b) => {
            const rank = m => m.stock<=0 ? 0 : m.stock<=(m.threshold||0) ? 1 : 2;
            const d = rank(a)-rank(b);
            return d!==0 ? d : (a.order??0)-(b.order??0);
        });
    },

    // ── Render ────────────────────────────────────────────────────────────────
    render() {
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
            const isEmpty    = m.stock <= 0;
            // maxStock = quantity at last refill/add. Bar = how full is the bottle.
            const maxS       = (m.maxStock && m.maxStock >= m.stock) ? m.maxStock : m.stock || 1;
            const barPct     = isEmpty ? 0 : Math.min(100, Math.max(1, Math.round((m.stock / maxS) * 100)));
            const barClass   = barPct>50?'bar-green':barPct>10?'bar-yellow':'bar-red';
            const colorClass = isEmpty?'status-empty':barPct>50?'status-high':barPct>10?'status-med':'status-low';

            const avg        = m.pattern ? m.pattern.reduce((a,b)=>a+b,0)/m.pattern.length : (m.frequency||1);
            const daysExact  = isEmpty ? 0 : m.stock / avg;
            const daysLeft   = isEmpty ? 0 : Math.floor(daysExact);
            const daysLabel  = daysExact > 0 && daysExact < 1 ? '< 1d' : `${daysLeft}d`;
            const dateStr    = new Date(Date.now()+Math.ceil(daysExact)*86_400_000).toLocaleDateString(undefined,{month:'short',day:'numeric'});
            const supplyLabel= isEmpty ? 'Out of stock' : `${daysLabel} · Refill by ${dateStr}`;

            const freqDisplay= m.pattern ? m.pattern.join('–') : m.frequency;
            const cycle      = m.pattern ? `<span class="cycle-tag">${m.pattern.join('-')}</span>` : '';
            const takenToday = !isEmpty && this.takenToday(m);

            // Quick refill button — shown when low or empty
            const isLow = !isEmpty && m.stock <= (m.threshold||0);
            const refillBtn = (isEmpty || isLow)
                ? `<button class="quick-refill-btn" onclick="App.quickRefill(${m.id})">+ Refill</button>`
                : '';

            const log = (m.doseLog||[]).slice(-5).reverse();
            const todayCount = (m.doseLog||[]).filter(e => new Date(e.ts).toDateString() === new Date().toDateString()).length;
            const logLabel = todayCount > 0 ? `Extra doses · ${todayCount} today` : `Extra doses taken (${log.length})`;
            const logHTML = log.length ? `
                <div class="dose-log">
                    <button class="dose-log-toggle" onclick="App.toggleLog(this)" aria-expanded="false">
                        <span>${logLabel}</span>
                        <svg class="toggle-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>
                    <div class="dose-log-body" hidden>
                        ${log.map(e=>{
                            const d=new Date(e.ts);
                            const dl=d.toDateString()===new Date().toDateString()?'Today':d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
                            const t=d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
                            return `<div class="dose-log-row"><span class="dose-log-time">${dl} · ${t}</span><span class="dose-log-amt">${e.amount} unit${e.amount>1?'s':''}</span></div>`;
                        }).join('')}
                    </div>
                </div>` : '';

            return `
            <div class="med-card ${isEmpty?'is-empty':''} ${(!isEmpty && takenToday)?'taken-today':''} ${isLow?'is-low':''}"
                 data-id="${m.id}">

                <div class="card-header">
                    <div class="card-title-row">
                        <div class="med-name">${m.name}${cycle}</div>
                        ${takenToday ? '<div class="taken-badge">✓ Taken today</div>' : ''}
                    </div>
                    <div class="med-meta">
                        <span class="${colorClass}">${isEmpty?'Out of stock':`${m.stock} ${m.stock === 1 ? "unit" : "units"}`}</span>
                        <span class="stat-sep">·</span>
                        <span class="daily-label">${freqDisplay}/day</span>
                        ${refillBtn}
                    </div>
                    <div class="supply-bar-track">
                        <div class="supply-bar-fill ${barClass}" style="width:${barPct}%"></div>
                    </div>
                    <div class="supply-label ${colorClass}">${supplyLabel}</div>
                </div>

                ${!isEmpty ? `
                <div class="extra-dose-area">
                    <div class="extra-dose-label">Extra dose</div>
                    <div class="stepper">
                        <button onclick="App.adjustExtraAmountCard(${m.id},-1)">−</button>
                        <span id="card-amt-${m.id}">1</span>
                        <button onclick="App.adjustExtraAmountCard(${m.id},1)">+</button>
                    </div>
                    <div class="slide-container" id="container-${m.id}">
                        <div class="slide-text">Slide to log extra dose</div>
                        <div class="slide-track" id="track-${m.id}"></div>
                        <div class="slide-handle" id="handle-${m.id}">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>
                        </div>
                    </div>
                </div>` : ''}

                <div class="edit-overlay">
                    <div class="drag-handle">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                    </div>
                    <button class="overlay-btn edit-btn-card"   onclick="App.openEdit(${m.id})">Edit</button>
                    <button class="overlay-btn delete-btn-card" onclick="App.deleteMed(${m.id},this)">Delete</button>
                </div>

                <div class="swipe-delete-bg"><span>Delete</span></div>

                ${logHTML}
            </div>`;
        }).join('');

        this.initCardSliders();
        this.initSwipeDelete();
        if (this.isEditMode) this.initDragReorder();
    },

    // ── Per-card extra dose amount stepper (on card, not in modal) ────────────
    adjustExtraAmountCard(id, delta) {
        const el  = document.getElementById(`card-amt-${id}`);
        const med = this.activeMeds.find(m => m.id===id);
        if (!el || !med) return;
        const cur = parseInt(el.textContent)||1;
        el.textContent = Math.max(1, Math.min(med.stock, cur+delta));
        this.haptic('light');
    },

    // ── Card sliders (extra dose) ─────────────────────────────────────────────
    initCardSliders() {
        this.activeMeds.forEach(m => {
            if (m.stock <= 0) return;
            const handle    = document.getElementById(`handle-${m.id}`);
            const container = document.getElementById(`container-${m.id}`);
            const track     = document.getElementById(`track-${m.id}`);
            if (!handle) return;

            let dragging = false;
            const getMax = () => container.offsetWidth - handle.offsetWidth - 10;

            const onStart = e => { if (!this.isEditMode) { e.stopPropagation(); dragging=true; } };
            const onMove  = e => {
                if (!dragging) return;
                const cx  = e.touches ? e.touches[0].clientX : e.clientX;
                const pos = Math.max(0, Math.min(cx - container.getBoundingClientRect().left - 24, getMax()));
                handle.style.left = `${pos+5}px`;
                track.style.width = `${pos+24}px`;
                if (pos >= getMax()) {
                    dragging = false;
                    const amtEl  = document.getElementById(`card-amt-${m.id}`);
                    const amount = parseInt(amtEl?.textContent)||1;
                    this._recordExtraDose(m.id, amount);
                }
            };
            const onEnd = () => {
                dragging = false;
                handle.style.left = '5px';
                track.style.width = '0';
            };

            handle.addEventListener('mousedown',  onStart);
            handle.addEventListener('touchstart', onStart, {passive:true});
            window.addEventListener('mousemove',  onMove);
            window.addEventListener('touchmove',  onMove, {passive:true});
            window.addEventListener('mouseup',    onEnd);
            window.addEventListener('touchend',   onEnd);
        });
    },

    _recordExtraDose(id, amount) {
        const med = this.activeMeds.find(m => m.id===id);
        if (!med) return;
        this.history = JSON.stringify(this.activeMeds);
        med.stock = Math.max(0, med.stock - amount);
        if (!med.doseLog) med.doseLog = [];
        med.doseLog.push({ ts: Date.now(), amount });
        if (med.doseLog.length > 30) med.doseLog = med.doseLog.slice(-30);
        this.haptic('success');
        // Flash the card green before re-rendering (#9)
        const card = this.listEl.querySelector(`[data-id="${id}"]`);
        if (card) {
            card.classList.add('slide-success');
            setTimeout(() => { this.save(); this.render(); }, 380);
        } else {
            this.save(); this.render();
        }
        this.showToast(`${amount} extra unit${amount>1?'s':''} recorded`, true);
        this.checkLowStockAlerts();
    },

    toggleLog(btn) {
        const body     = btn.nextElementSibling;
        const expanded = btn.getAttribute('aria-expanded')==='true';
        btn.setAttribute('aria-expanded', !expanded);
        body.hidden = expanded;
        btn.querySelector('.toggle-chevron').style.transform = expanded?'':'rotate(180deg)';
    },

    // ── Swipe-to-delete ───────────────────────────────────────────────────────
    initSwipeDelete() {
        this.listEl.querySelectorAll('.med-card').forEach(card => {
            let startX=0, startY=0, dx=0, swiping=false;
            const THRESHOLD=80;

            const onStart = e => {
                if (this.isEditMode) return;
                // Don't activate swipe if the touch started on the slide handle
                if (e.target?.closest('.slide-handle, .slide-container, .stepper')) return;
                const t=e.touches?.[0]||e;
                startX=t.clientX; startY=t.clientY; dx=0; swiping=false;
                card.style.transition='none';
            };
            const onMove = e => {
                if (this.isEditMode) return;
                const t=e.touches?.[0]||e;
                dx=t.clientX-startX;
                const dy=Math.abs(t.clientY-startY);
                if (!swiping && Math.abs(dx)>8 && dy<20) swiping=true;
                if (!swiping||dx>0) return;
                card.style.transform=`translateX(${dx}px)`;
                card.querySelector('.swipe-delete-bg').style.opacity=Math.min(1,Math.abs(dx)/THRESHOLD);
            };
            const onEnd = () => {
                if (!swiping) return;
                card.style.transition='transform 0.3s ease,opacity 0.3s ease';
                if (dx < -THRESHOLD) {
                    card.style.transform='translateX(-100%)';
                    card.style.opacity='0';
                    setTimeout(()=>{
                        const id=parseInt(card.dataset.id);
                        this.activeMeds=this.activeMeds.filter(m=>m.id!==id);
                        this.save(); this.render();
                    },300);
                } else {
                    card.style.transform='translateX(0)';
                    card.querySelector('.swipe-delete-bg').style.opacity='0';
                }
            };

            card.addEventListener('touchstart', onStart, {passive:true});
            card.addEventListener('touchmove',  onMove,  {passive:true});
            card.addEventListener('touchend',   onEnd);
        });
    },

    // ── Drag to reorder ───────────────────────────────────────────────────────
    initDragReorder() {
        let dragged=null, placeholder=null;
        this.listEl.querySelectorAll('.med-card').forEach(card => {
            const handle=card.querySelector('.drag-handle');
            if (!handle) return;

            handle.addEventListener('touchstart', e=>{
                dragged=card; card.classList.add('dragging');
                placeholder=document.createElement('div');
                placeholder.className='drag-placeholder';
                placeholder.style.height=card.offsetHeight+'px';
                card.after(placeholder); this.haptic('light');
            },{passive:true});

            handle.addEventListener('touchmove', e=>{
                if (!dragged) return;
                e.preventDefault();
                const touch=e.touches[0];
                Object.assign(dragged.style,{position:'fixed',zIndex:'999',width:dragged.offsetWidth+'px',top:(touch.clientY-dragged.offsetHeight/2)+'px',left:dragged.getBoundingClientRect().left+'px'});
                const els=document.elementsFromPoint(touch.clientX,touch.clientY);
                const target=els.find(el=>el.classList?.contains('med-card')&&el!==dragged);
                if (target) {
                    const box=target.getBoundingClientRect();
                    touch.clientY<box.top+box.height/2 ? target.before(placeholder) : target.after(placeholder);
                }
            },{passive:false});

            handle.addEventListener('touchend', ()=>{
                if (!dragged) return;
                Object.assign(dragged.style,{position:'',zIndex:'',width:'',top:'',left:''});
                dragged.classList.remove('dragging');
                placeholder?.replaceWith(dragged);
                placeholder=null;
                [...this.listEl.querySelectorAll('.med-card')].forEach((c,i)=>{
                    const med=this.activeMeds.find(m=>m.id===parseInt(c.dataset.id));
                    if (med) med.order=i;
                });
                this.save(); dragged=null;
            });
        });
    },

    // ── Delete ────────────────────────────────────────────────────────────────
    deleteMed(id, btnEl) {
        const card=btnEl?.closest('.med-card')||this.listEl.querySelector(`[data-id="${id}"]`);
        if (!card) return;
        if (card.dataset.confirmDelete==='true') {
            card.style.transition='transform 0.3s,opacity 0.3s';
            card.style.opacity='0'; card.style.transform='scale(0.95)';
            setTimeout(()=>{ this.activeMeds=this.activeMeds.filter(m=>m.id!==id); this.save(); this.render(); },280);
        } else {
            card.dataset.confirmDelete='true';
            if (btnEl) { btnEl.textContent='Confirm?'; btnEl.style.background='var(--warning)'; }
            setTimeout(()=>{
                if (card.dataset.confirmDelete==='true') {
                    card.dataset.confirmDelete='false';
                    if (btnEl) { btnEl.textContent='Delete'; btnEl.style.background=''; }
                }
            },2500);
        }
    },

    showToast(msg, withUndo=false) {
        this.toastEl.querySelector('.toast-msg').textContent=msg;
        this.toastEl.querySelector('.toast-undo').style.display=withUndo?'inline':'none';
        this.toastEl.classList.add('active');
        clearTimeout(this._toastTimer);
        this._toastTimer=setTimeout(()=>this.toastEl.classList.remove('active'),4000);
    },

    undo() {
        if (!this.history) return;
        this.activeMeds=JSON.parse(this.history);
        this.history=null;
        this.haptic('medium'); this.save(); this.render();
        this.toastEl.classList.remove('active');
    },

    save() {
        STORAGE.save(this.activeMeds, this.lastSync);
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.ready.then(reg => {
                reg.active?.postMessage({ type:'PERSIST_TO_IDB', meds:this.activeMeds, syncTime:this.lastSync });
            });
        }
    }
};

App.init();