let medicines = JSON.parse(localStorage.getItem('meds_v2')) || [];
let lastCheck = localStorage.getItem('last_sync_time') || Date.now();

const medList = document.getElementById('med-list');
const lockToggle = document.getElementById('lock-toggle');
const appContainer = document.querySelector('.app-container');

// --- Core Logic ---

function syncDailyDoses() {
    const now = Date.now();
    const msInDay = 24 * 60 * 60 * 1000;
    const timePassed = now - lastCheck;
    
    if (timePassed >= msInDay) {
        const daysToSubtract = Math.floor(timePassed / msInDay);
        
        medicines = medicines.map(med => {
            const totalDose = med.frequency * daysToSubtract;
            const newStock = Math.max(0, med.stock - totalDose);
            
            if (newStock <= med.threshold) {
                sendNotification(`Daily Sync: ${med.name} is low!`);
            }
            return { ...med, stock: newStock };
        });

        lastCheck = now - (timePassed % msInDay); // Reset to last even 24h block
        localStorage.setItem('last_sync_time', lastCheck);
        saveAndRender();
    }
}

function saveAndRender() {
    localStorage.setItem('meds_v2', JSON.stringify(medicines));
    medList.innerHTML = '';
    
    // Apply visual lock
    if (lockToggle.checked) {
        appContainer.classList.add('locked-mode');
    } else {
        appContainer.classList.remove('locked-mode');
    }

    medicines.forEach((med, index) => {
        const isLow = med.stock <= med.threshold;
        const div = document.createElement('div');
        div.className = 'med-item';
        div.innerHTML = `
            <div class="med-info">
                <b>${med.name}</b>
                <span class="${isLow ? 'critical' : ''}">
                    Stock: ${med.stock} (Target: ${med.threshold})
                </span>
                <div style="font-size:10px">Auto-subtract: ${med.frequency}/day</div>
            </div>
            <div class="btn-group">
                <button class="small-btn" onclick="updateStock(${index}, -1)">-</button>
                <button class="take-btn" onclick="updateStock(${index}, -${med.frequency})">Take</button>
                <button class="small-btn" onclick="updateStock(${index}, 1)">+</button>
            </div>
        `;
        medList.appendChild(div);
    });
}

function updateStock(index, amount) {
    medicines[index].stock = Math.max(0, medicines[index].stock + amount);
    if (amount < 0 && medicines[index].stock <= medicines[index].threshold) {
        sendNotification(`Low Stock: ${medicines[index].name}`);
    }
    saveAndRender();
}

// --- Inputs ---

document.getElementById('add-btn').onclick = () => {
    const name = document.getElementById('med-name').value;
    const stock = parseInt(document.getElementById('med-stock').value);
    const freq = parseInt(document.getElementById('med-frequency').value);
    const thresh = parseInt(document.getElementById('med-threshold').value);

    if (name && !isNaN(stock)) {
        medicines.push({ name, stock, frequency: freq || 1, threshold: thresh || 5 });
        saveAndRender();
        document.querySelectorAll('input').forEach(i => i.value = '');
    }
};

// --- Notifications ---

function sendNotification(text) {
    if (Notification.permission === 'granted') {
        new Notification("Medicine Tracker", { body: text });
    }
}

document.getElementById('notif-btn').onclick = () => {
    Notification.requestPermission();
};

// --- Initialization ---

lockToggle.onchange = saveAndRender;
setInterval(syncDailyDoses, 60000); // Check every minute while app is open
syncDailyDoses();
saveAndRender();