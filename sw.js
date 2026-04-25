self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('Service Worker Active');
});

// Listen for the app to trigger a notification
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'LOW_STOCK_ALERT') {
        const { name, stock } = event.data.payload;
        
        self.registration.showNotification('⚠️ Low Stock Alert', {
            body: `${name} is running low! Only ${stock} left.`,
            icon: 'images/icon.png',
            badge: 'images/icon.png',
            vibrate: [200, 100, 200],
            tag: 'stock-alert-' + name,
            data: { url: self.registration.scope }
        });
    }
});

// Open the app when the notification is clicked
self.onnotificationclick = (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            if (clientList.length > 0) return clientList[0].focus();
            return clients.openWindow('./');
        })
    );
};