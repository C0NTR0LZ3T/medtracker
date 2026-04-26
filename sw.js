const MEDS_KEY = 'medtracker_meds_v1';
const SYNC_KEY = 'medtracker_sync_v1';
const SYNC_TAG = 'daily-stock-deduction';

// ── Install & activate ────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
    e.waitUntil(self.clients.claim());
});

// ── Periodic Background Sync ──────────────────────────────────────────────
// Fires once a day (or as close as Chrome allows) even when app is closed.
self.addEventListener('periodicsync', e => {
    if (e.tag === SYNC_TAG) {
        e.waitUntil(runBackgroundDeduction());
    }
});

async function runBackgroundDeduction() {
    // Service workers can't access localStorage — we use IndexedDB via
    // a tiny helper that mirrors what the app stores.
    const db   = await openDB();
    const meds = await dbGet(db, MEDS_KEY);
    const sync = await dbGet(db, SYNC_KEY);

    if (!meds || !sync) return; // nothing saved yet

    const now        = Date.now();
    const lastSync   = parseInt(sync) || now;
    const days       = Math.floor((now - lastSync) / 86_400_000);
    if (days < 1) return;

    let changed = false;
    const updated = meds.map(m => {
        for (let i = 0; i < days; i++) {
            const amt = m.pattern
                ? m.pattern[m.patternIdx % m.pattern.length]
                : (m.frequency || 0);
            m.stock = Math.max(0, m.stock - amt);
            if (m.pattern) {
                m.patternIdx = (m.patternIdx + 1) % m.pattern.length;
                m.takeAmount = m.pattern[m.patternIdx];
            }
            changed = true;
        }
        return m;
    });

    if (!changed) return;

    const newSync = lastSync + days * 86_400_000;
    await dbSet(db, MEDS_KEY, updated);
    await dbSet(db, SYNC_KEY, String(newSync));

    // Fire low-stock notifications for any critical meds
    updated.forEach(m => {
        if (m.stock > 0 && m.stock <= (m.threshold || 0)) {
            self.registration.showNotification('⚠️ Low Stock Alert', {
                body:    `${m.name} is running low — only ${m.stock} unit${m.stock !== 1 ? 's' : ''} left.`,
                icon:    'images/icon.png',
                badge:   'images/icon.png',
                vibrate: [200, 100, 200],
                tag:     'stock-alert-' + m.name,
                data:    { url: self.registration.scope }
            });
        }
        if (m.stock <= 0) {
            self.registration.showNotification('🚨 Out of Stock', {
                body:    `${m.name} has run out. Time to refill.`,
                icon:    'images/icon.png',
                badge:   'images/icon.png',
                vibrate: [300, 100, 300],
                tag:     'empty-alert-' + m.name,
                data:    { url: self.registration.scope }
            });
        }
    });

    // Tell any open app tabs to re-render with the new data
    const allClients = await self.clients.matchAll({ type: 'window' });
    allClients.forEach(c => c.postMessage({ type: 'BG_SYNC_COMPLETE' }));
}

// ── Manual message from app ───────────────────────────────────────────────
self.addEventListener('message', event => {
    if (!event.data) return;

    if (event.data.type === 'LOW_STOCK_ALERT') {
        const { name, stock } = event.data.payload;
        self.registration.showNotification('⚠️ Low Stock Alert', {
            body:    `${name} is running low — only ${stock} unit${stock !== 1 ? 's' : ''} left.`,
            icon:    'images/icon.png',
            badge:   'images/icon.png',
            vibrate: [200, 100, 200],
            tag:     'stock-alert-' + name,
            data:    { url: self.registration.scope }
        });
    }

    // App writes its current state to IDB so the SW can read it during bg sync
    if (event.data.type === 'PERSIST_TO_IDB') {
        openDB().then(db => {
            dbSet(db, MEDS_KEY, event.data.meds);
            dbSet(db, SYNC_KEY, String(event.data.syncTime));
        });
    }
});

// ── Notification click ────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then(list => {
            if (list.length > 0) return list[0].focus();
            return self.clients.openWindow('./');
        })
    );
});

// ── Minimal IndexedDB helpers ─────────────────────────────────────────────
// localStorage is not available in SW scope — IDB is the bridge.
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('medtracker_sw', 1);
        req.onupgradeneeded = e => {
            e.target.result.createObjectStore('kv');
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

function dbGet(db, key) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = e => resolve(e.target.result ?? null);
        req.onerror   = e => reject(e.target.error);
    });
}

function dbSet(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction('kv', 'readwrite');
        const req = tx.objectStore('kv').put(value, key);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}
