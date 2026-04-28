const MEDS_KEY  = 'medtracker_meds_v1';
const SYNC_KEY  = 'medtracker_sync_v1';
const SYNC_TAG  = 'daily-stock-deduction';
const SW_VERSION = 4; // bump this with every deployment

// ── Install & activate ────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
    e.waitUntil(
        self.clients.claim().then(async () => {
            // Tell all open tabs a new version is available
            const allClients = await self.clients.matchAll({ type: 'window' });
            allClients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
        })
    );
});

// ── Periodic Background Sync ──────────────────────────────────────────────
self.addEventListener('periodicsync', e => {
    if (e.tag === SYNC_TAG) {
        e.waitUntil(runBackgroundDeduction());
    }
});

async function runBackgroundDeduction() {
    const db   = await openDB();
    const meds = await dbGet(db, MEDS_KEY);
    const sync = await dbGet(db, SYNC_KEY);

    if (!meds || !sync) return;

    const now      = Date.now();
    const lastSync = parseInt(sync) || now;
    const days     = Math.floor((now - lastSync) / 86400000);
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
            }
            changed = true;
        }
        return m;
    });

    if (!changed) return;

    const nextSyncTime = lastSync + (days * 86400000);
    await dbSet(db, MEDS_KEY, updated);
    await dbSet(db, SYNC_KEY, String(nextSyncTime));

    // Notify user if stock is low or empty after background deduction
    for (const m of updated) {
        if (m.stock <= 0) {
            await self.registration.showNotification('🚨 Out of Stock', {
                body:    `${m.name} has run out.`,
                icon:    'images/icon.png',
                badge:   'images/icon.png',
                vibrate: [300, 100, 300],
                tag:     'empty-' + m.name,
                data:    { url: self.registration.scope }
            });
        } else if (m.stock <= (m.threshold || 0)) {
            await self.registration.showNotification('⚠️ Low Stock Alert', {
                body:    `${m.name} is running low (${m.stock} left).`,
                icon:    'images/icon.png',
                badge:   'images/icon.png',
                vibrate: [200, 100, 200],
                tag:     'low-' + m.name,
                data:    { url: self.registration.scope }
            });
        }
    }

    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'BG_SYNC_COMPLETE' }));

    // Also fire any dose reminders whose time window falls within the last hour
    // (fallback for devices that don't support Notification Triggers)
    await checkDoseReminders();
}

// ── Message handling ──────────────────────────────────────────────────────
self.addEventListener('message', event => {
    if (!event.data) return;

    // Primary notification pathway used by the app
    if (event.data.type === 'SHOW_NOTIFICATION') {
        self.registration.showNotification(event.data.title, {
            body:    event.data.body,
            icon:    'images/icon.png',
            badge:   'images/icon.png',
            vibrate: [100, 50, 100],
            tag:     event.data.tag || 'medtracker',
            data:    { url: self.registration.scope }
        });
    }

    // Store reminder schedule so periodic sync can fire them as fallback
    if (event.data.type === 'SCHEDULE_REMINDERS') {
        openDB().then(db => dbSet(db, 'reminders_v1', event.data.meds));
    }

    // Legacy / direct notification pathways (kept for compatibility)
    if (event.data.type === 'REFILL_REMINDER') {
        const { name, daysLeft } = event.data.payload;
        self.registration.showNotification('🗓 Refill Reminder', {
            body:    `${name} will run out in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Time to reorder.`,
            icon:    'images/icon.png',
            badge:   'images/icon.png',
            vibrate: [100, 50, 100],
            tag:     'refill-' + name,
            data:    { url: self.registration.scope }
        });
    }

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

    // Syncs localStorage data into IndexedDB so the worker can see it during bg sync
    if (event.data.type === 'PERSIST_TO_IDB') {
        openDB().then(db => {
            dbSet(db, MEDS_KEY, event.data.meds);
            dbSet(db, SYNC_KEY, String(event.data.syncTime));
        });
    }
});

// ── Notification click & actions ──────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    const { action, notification } = event;
    notification.close();

    if (action === 'snooze') {
        // Re-fire the notification 30 minutes from now
        const { medName, time } = notification.data || {};
        event.waitUntil(
            new Promise(resolve => {
                setTimeout(async () => {
                    await self.registration.showNotification(`💊 Snoozed: ${medName || 'Medication'}`, {
                        body:    `Your ${time || ''} dose reminder (snoozed)`,
                        icon:    'images/icon.png',
                        badge:   'images/icon.png',
                        vibrate: [200, 100, 200],
                        tag:     notification.tag + '-snooze',
                        actions: [
                            { action: 'snooze',  title: '⏰ Snooze 30min' },
                            { action: 'dismiss', title: '✓ Dismiss' }
                        ],
                        data: notification.data
                    });
                    resolve();
                }, 30 * 60 * 1000); // 30 minutes
                resolve(); // resolve immediately so SW doesn't get killed
            })
        );
        return;
    }

    // 'dismiss' action or tapping the notification body — open the app
    if (action === 'dismiss') return;

    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then(list => {
            if (list.length > 0) return list[0].focus();
            return self.clients.openWindow(notification.data?.url || './');
        })
    );
});

// ── Dose reminder check (periodic-sync fallback) ──────────────────────────
async function checkDoseReminders() {
    try {
        const db       = await openDB();
        const schedule = await dbGet(db, 'reminders_v1');
        if (!schedule?.length) return;

        const now     = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();

        for (const med of schedule) {
            for (const time of (med.reminders || [])) {
                const [h, m]     = time.split(':').map(Number);
                const targetMins = h * 60 + m;
                const diff       = Math.abs(nowMins - targetMins);
                // Fire if within ±30 min (periodic sync isn't exact to the minute)
                if (diff <= 30) {
                    await self.registration.showNotification(`💊 Time to take ${med.name}`, {
                        body:    `Your ${time} dose reminder`,
                        icon:    'images/icon.png',
                        badge:   'images/icon.png',
                        vibrate: [200, 100, 200],
                        tag:     `dose-reminder-${med.id}-${time}`,
                        renotify: true,
                        actions: [
                            { action: 'snooze',  title: '⏰ Snooze 30min' },
                            { action: 'dismiss', title: '✓ Dismiss' }
                        ],
                        data:    { url: self.registration.scope, medId: med.id, medName: med.name, time }
                    });
                }
            }
        }
    } catch(e) {
        console.warn('[MedTracker] Dose reminder check failed:', e);
    }
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('medtracker_db', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
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