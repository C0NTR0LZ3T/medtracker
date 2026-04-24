const master_list = ["Multivitamin", "Ibuprofen", "Aspirin", "Omega 3", "Vitamin D3"];

const App = {
    activeMeds: JSON.parse(localStorage.getItem('meds_inventory_v11')) || [],
    lastSync: parseInt(localStorage.getItem('sync_time_v11')) || Date.now(),
    isEditMode: false,

    init() {
        this.cacheDOM();
        this.populateSelector();
        this.bindEvents();
        this.runDailySync();
        setInterval(() => this.runDailySync(), 60000);
        this.render();
    },

    cacheDOM() {
        this.listEl = document.getElementById('med-list');
        this.selectorEl = document.getElementById('med-selector');
        this.customNameEl = document.getElementById('custom-name');
        this.stockEl = document.getElementById('new-stock');
        this.freqEl = document.getElementById('new-freq');
        this.syncEl = document.getElementById('sync-display');
        this.editBtn = document.getElementById('edit-mode-btn');
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
        this.editBtn.onclick = () => this.toggleEditMode();
    },

    toggleEditMode() {
        this.isEditMode = !this.isEditMode;
        document.body.classList.toggle('edit-active', this.isEditMode);
        this.editBtn.innerText = this.isEditMode ? "DONE" : "EDIT";
        this.editBtn.classList.toggle('active', this.isEditMode);
    },

    addNewMed() {
        const name = this.customNameEl.value.trim() || this.selectorEl.value;
        const stock = parseInt(this.stockEl.value);
        const freq = parseInt(this.freqEl.value);

        if (!name || isNaN(stock)) return alert("Please enter Name and Stock.");

        const autoThreshold = Math.floor(stock * 0.10);

        this.activeMeds.push({
            id: Date.now(),
            name: name,
            initialStock: stock,
            stock: stock,
            frequency: freq || 0,
            threshold: autoThreshold,
            takeAmount: 1
        });

        this.save();
        this.render();
        [this.customNameEl, this.selectorEl, this.stockEl, this.freqEl].forEach(el => el.value = "");
    },

    getStockClass(current, initial, threshold) {
        if (current <= 0) return 'status-low';
        if (current <= threshold) return 'status-low';
        if (current <= (initial / 2)) return 'status-med';
        return 'status-high';
    },

    handleTake(id) {
        this.activeMeds = this.activeMeds.map(m => {
            if (m.id === id) {
                return { ...m, stock: Math.max(0, m.stock - m.takeAmount), takeAmount: 1 };
            }
            return m;
        });
        this.save();
        this.render();
    },

    updateTakeAmount(id, delta) {
        if (this.isEditMode) return;
        const med = this.activeMeds.find(m => m.id === id);
        if (med) {
            med.takeAmount = Math.max(1, med.takeAmount + delta);
            this.render();
        }
    },

    runDailySync() {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        if (now - this.lastSync >= oneDay) {
            const days = Math.floor((now - this.lastSync) / oneDay);
            this.activeMeds = this.activeMeds.map(m => ({
                ...m, stock: Math.max(0, m.stock - (m.frequency * days))
            }));
            this.lastSync += (days * oneDay);
            this.save();
            this.render();
        }
        this.syncEl.innerText = "auto-deduct every 24 hours";
    },

    save() {
        localStorage.setItem('meds_inventory_v11', JSON.stringify(this.activeMeds));
        localStorage.setItem('sync_time_v11', this.lastSync);
    },

    getImagePath(name) {
        if (!master_list.includes(name)) return `images/meds/generic.png`;
        const clean = name.toLowerCase().replace(/\s+/g, '_').replace(/[^\w-]+/g, '');
        return `images/meds/${clean}.png`;
    },

    render() {
        this.listEl.innerHTML = this.activeMeds.map(m => {
            const colorClass = this.getStockClass(m.stock, m.initialStock, m.threshold);
            const emptyClass = m.stock <= 0 ? 'is-empty' : '';

            return `
            <div class="med-card ${emptyClass}" id="card-${m.id}">
                <div class="del-badge" onclick="App.deleteMed(${m.id})">−</div>
                <div class="card-top">
                    <div class="med-details">
                        <b>${m.name}</b>
                        <div class="med-stats">
                            <span class="${colorClass}">Stock: ${m.stock}</span><br>
                            Daily: ${m.frequency}
                        </div>
                    </div>
                    <img src="${this.getImagePath(m.name)}" class="med-icon" onerror="this.src='images/meds/generic.png'">
                </div>
                <div class="action-area">
                    <div class="stepper">
                        <button onclick="App.updateTakeAmount(${m.id}, -1)">-</button>
                        <span>Take ${m.takeAmount}</span>
                        <button onclick="App.updateTakeAmount(${m.id}, 1)">+</button>
                    </div>
                    <div class="slide-container" id="container-${m.id}">
                        <div class="slide-text">SLIDE TO CONFIRM</div>
                        <div class="slide-track" id="track-${m.id}"></div>
                        <div class="slide-handle" id="handle-${m.id}"></div>
                    </div>
                </div>
            </div>
        `;}).join('');

        // Re-initialize slider listeners for each card
        this.activeMeds.forEach(m => this.initSlider(m.id));
    },

    initSlider(id) {
        const handle = document.getElementById(`handle-${id}`);
        const container = document.getElementById(`container-${id}`);
        const track = document.getElementById(`track-${id}`);
        if (!handle) return;

        let isDragging = false;
        const maxSlide = container.offsetWidth - handle.offsetWidth - 8;

        const start = (e) => {
            if (this.isEditMode) return;
            isDragging = true;
            // Prevent scrolling while sliding on mobile
            if(e.type === 'touchstart') document.body.style.overflow = 'hidden';
        };

        const move = (e) => {
            if (!isDragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const xPos = clientX - container.getBoundingClientRect().left - 23;
            const clampedX = Math.max(0, Math.min(xPos, maxSlide));
            
            handle.style.left = `${clampedX + 4}px`;
            track.style.width = `${clampedX + 23}px`;
            
            if (clampedX >= maxSlide) {
                isDragging = false;
                document.body.style.overflow = '';
                this.handleTake(id);
            }
        };

        const end = () => {
            isDragging = false;
            document.body.style.overflow = '';
            handle.style.left = `4px`;
            track.style.width = `0px`;
        };

        // Use Event Listeners instead of .on property to support multiple instances
        handle.addEventListener('mousedown', start);
        handle.addEventListener('touchstart', start, { passive: true });

        window.addEventListener('mousemove', move);
        window.addEventListener('touchmove', move, { passive: false });

        window.addEventListener('mouseup', end);
        window.addEventListener('touchend', end);
    },

    deleteMed(id) {
        if(confirm("Permanently delete this tracker?")) {
            this.activeMeds = this.activeMeds.filter(m => m.id !== id);
            this.save();
            this.render();
        }
    }
};

App.init();