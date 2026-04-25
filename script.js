const master_list = ["Nexium", "Metoprolol", "Euthyrox", "Yasmin", "Procombo", "Rinvoq"];

const App = {
    // Restored to your original storage key
    activeMeds: JSON.parse(localStorage.getItem('meds_inventory_v15')) || [],
    lastSync: parseInt(localStorage.getItem('sync_time_v15')) || Date.now(),
    history: null,
    isEditMode: false,
    pendingAction: null,

    init() {
        this.cacheDOM();
        this.populateSelector();
        this.syncStock(); // Logic for 24h auto-deduction
        this.bindEvents();
        this.render();
    },

    cacheDOM() {
        this.listEl = document.getElementById('med-list');
        this.toastEl = document.getElementById('undo-toast');
        this.selectorEl = document.getElementById('med-selector');
        this.editBtn = document.getElementById('edit-mode-btn');
        this.modal = document.getElementById('refill-modal');
        this.modalBody = document.getElementById('modal-body');
    },

    // NEW: Auto-deduct logic based on your 24h requirement
    syncStock() {
        const now = Date.now();
        const diff = now - this.lastSync;
        const daysPassed = Math.floor(diff / (24 * 60 * 60 * 1000));

        if (daysPassed >= 1) {
            this.activeMeds = this.activeMeds.map(m => {
                for (let i = 0; i < daysPassed; i++) {
                    const amt = m.pattern ? m.pattern[m.patternIdx] : (m.frequency || 0);
                    m.stock = Math.max(0, m.stock - amt);
                    if (m.pattern) {
                        m.patternIdx = (m.patternIdx + 1) % m.pattern.length;
                        m.takeAmount = m.pattern[m.patternIdx];
                    }
                }
                return m;
            });
            this.lastSync = now - (diff % (24 * 60 * 60 * 1000));
            this.save();
        }
    },

    haptic(type = 'light') {
        if (!navigator.vibrate) return;
        if (type === 'light') navigator.vibrate(10);
        if (type === 'medium') navigator.vibrate(30);
        if (type === 'success') navigator.vibrate([20, 30, 20]);
    },

    populateSelector() {
        master_list.forEach(name => {
            let opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            this.selectorEl.appendChild(opt);
        });
    },

    bindEvents() {
        document.getElementById('add-track-btn').onclick = () => this.addNewMed();
        
        this.editBtn.onclick = () => {
            this.isEditMode = !this.isEditMode;
            document.body.classList.toggle('edit-active', this.isEditMode);
            this.editBtn.classList.toggle('active', this.isEditMode);
            this.haptic('medium');

            this.editBtn.style.opacity = '0';
            setTimeout(() => {
                this.editBtn.innerText = this.isEditMode ? "DONE" : "EDIT";
                this.editBtn.style.opacity = '1';
                this.render(); 
            }, 150);
        };

        // Modal Events
        document.getElementById('modal-add').onclick = () => this.confirmRefill('add');
        document.getElementById('modal-replace').onclick = () => this.confirmRefill('replace');
        document.getElementById('modal-cancel').onclick = () => this.modal.classList.remove('active');
    },

    addNewMed() {
        const name = document.getElementById('custom-name').value.trim() || this.selectorEl.value;
        const stock = parseInt(document.getElementById('new-stock').value);
        const freqVal = document.getElementById('new-freq').value.toString().trim();

        if (!name || isNaN(stock)) return;

        // Support for "2-3" pattern
        const pattern = freqVal.includes('-') ? freqVal.split('-').map(Number) : null;
        const frequency = pattern ? pattern[0] : (parseInt(freqVal) || 0);

        const existing = this.activeMeds.find(m => m.name.toLowerCase() === name.toLowerCase());

        if (existing) {
            this.pendingAction = { existing, stock, frequency, pattern };
            this.modalBody.innerText = `${existing.name} has ${existing.stock} pills. Choose action:`;
            this.modal.classList.add('active');
        } else {
            this.activeMeds.push({
                id: Date.now(),
                name,
                stock,
                frequency,
                pattern,
                patternIdx: 0,
                threshold: Math.floor(stock * 0.1),
                takeAmount: frequency || 1
            });
            this.haptic('medium');
            this.finalize();
        }
    },

    confirmRefill(type) {
        const { existing, stock, frequency, pattern } = this.pendingAction;
        if (type === 'add') existing.stock += stock;
        else existing.stock = stock;
        
        existing.frequency = frequency;
        existing.pattern = pattern;
        existing.patternIdx = 0;
        existing.takeAmount = frequency || 1;
        
        this.modal.classList.remove('active');
        this.haptic('success');
        this.finalize();
    },

    finalize() {
        document.getElementById('custom-name').value = "";
        document.getElementById('new-stock').value = "";
        document.getElementById('new-freq').value = "";
        this.save();
        this.render();
    },

    render() {
        this.listEl.innerHTML = this.activeMeds.map(m => {
            const isEmpty = m.stock <= 0;
            const colorClass = m.stock <= (m.threshold || 0) ? 'status-low' : 'status-high';
            const cycle = m.pattern ? `<span class="cycle-tag">${m.pattern.join('-')}</span>` : '';
            
            return `
            <div class="med-card ${isEmpty ? 'is-empty' : ''}">
                <div class="del-badge" onclick="App.deleteMed(${m.id})">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </div>
                <div class="card-top">
                    <div class="med-details">
                        <b>${m.name}${cycle}</b>
                        <div class="med-stats">
                            <span class="${colorClass}">Stock: ${m.stock}</span><br>
                            Daily: ${m.frequency}
                        </div>
                    </div>
                    <img src="images/${m.name.toLowerCase().replace(/\s+/g, '_')}.png" class="med-icon" onerror="this.src='images/generic.png'">
                </div>
                <div class="action-area">
                    <div class="stepper">
                        <button onclick="App.adjStep(${m.id}, -1)">−</button>
                        <span id="step-${m.id}">Take ${m.takeAmount}</span>
                        <button onclick="App.adjStep(${m.id}, 1)">+</button>
                    </div>
                    <div class="slide-container" id="container-${m.id}">
                        <div class="slide-text">SLIDE TO CONFIRM</div>
                        <div class="slide-track" id="track-${m.id}"></div>
                        <div class="slide-handle" id="handle-${m.id}"></div>
                    </div>
                </div>
            </div>`;
        }).join('');
        this.activeMeds.forEach(m => this.initSlider(m.id));
    },

    adjStep(id, delta) {
        if (this.isEditMode) return;
        const med = this.activeMeds.find(m => m.id === id);
        med.takeAmount = Math.max(1, (med.takeAmount || 1) + delta);
        this.haptic('light');
        this.render();
    },

    handleTake(id) {
        this.history = JSON.stringify(this.activeMeds);
        this.activeMeds = this.activeMeds.map(m => {
            if (m.id === id) {
                m.stock = Math.max(0, m.stock - (m.takeAmount || 1));
                if (m.pattern) {
                    m.patternIdx = (m.patternIdx + 1) % m.pattern.length;
                    m.takeAmount = m.pattern[m.patternIdx];
                }
            }
            return m;
        });
        this.haptic('success');
        this.save();
        this.render();
        this.toastEl.classList.add('active');
        setTimeout(() => this.toastEl.classList.remove('active'), 4000);
    },

    undo() {
        if (this.history) {
            this.activeMeds = JSON.parse(this.history);
            this.history = null;
            this.haptic('medium');
            this.save();
            this.render();
        }
    },

    initSlider(id) {
        const handle = document.getElementById(`handle-${id}`);
        const container = document.getElementById(`container-${id}`);
        const track = document.getElementById(`track-${id}`);
        if (!handle) return;
        let isDragging = false;
        const max = container.offsetWidth - handle.offsetWidth - 10;
        const start = () => { if (!this.isEditMode) isDragging = true; };
        const move = (e) => {
            if (!isDragging) return;
            const x = (e.touches ? e.touches[0].clientX : e.clientX) - container.getBoundingClientRect().left - 24;
            const pos = Math.max(0, Math.min(x, max));
            handle.style.left = `${pos + 5}px`;
            track.style.width = `${pos + 24}px`;
            if (pos >= max) { isDragging = false; this.handleTake(id); }
        };
        const end = () => { isDragging = false; handle.style.left = '5px'; track.style.width = '0'; };
        handle.addEventListener('mousedown', start);
        handle.addEventListener('touchstart', start);
        window.addEventListener('mousemove', move);
        window.addEventListener('touchmove', move);
        window.addEventListener('mouseup', end);
        window.addEventListener('touchend', end);
    },

    deleteMed(id) {
        if (confirm("Delete tracker?")) {
            this.activeMeds = this.activeMeds.filter(m => m.id !== id);
            this.save();
            this.render();
        }
    },

    save() {
        localStorage.setItem('meds_inventory_v15', JSON.stringify(this.activeMeds));
        localStorage.setItem('sync_time_v15', this.lastSync);
    }
};

App.init();