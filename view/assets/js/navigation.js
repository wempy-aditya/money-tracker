// navigation.js - Shared navigation component for all pages

function createNavigation() {
    const nav = document.createElement('nav');
    nav.className = 'bg-white shadow-md py-4 px-6 mb-8';
    nav.innerHTML = `
        <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between">
            <div class="flex items-center">
                <a href="/home" class="flex items-center text-xl font-bold text-blue-600">
                    <i class="fas fa-wallet mr-2"></i>
                    <span>Daily Money Tracker</span>
                </a>
            </div>
            <div class="flex space-x-4">
                <a href="/home" class="px-4 py-2 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors flex items-center">
                    <i class="fas fa-home mr-2"></i>
                    <span>Dashboard</span>
                </a>
                <a href="/" class="px-4 py-2 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors flex items-center">
                    <i class="fas fa-wallet mr-2"></i>
                    <span>Wallets</span>
                </a>
                <a href="/budget" class="px-4 py-2 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors flex items-center">
                    <i class="fas fa-chart-pie mr-2"></i>
                    <span>Budget</span>
                </a>
                <a href="/transactions" class="px-4 py-2 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors flex items-center">
                    <i class="fas fa-exchange-alt mr-2"></i>
                    <span>Transactions</span>
                </a>
            </div>
        </div>
    `;
    
    // Highlight current page
    const currentPath = window.location.pathname;
    const links = nav.querySelectorAll('a');
    
    links.forEach(link => {
        if (link.getAttribute('href') === currentPath) {
            link.classList.add('bg-blue-100');
            link.classList.add('font-medium');
        }
    });
    
    return nav;
}

function insertNavigation() {
    const body = document.body;
    const firstChild = body.firstChild;
    
    const nav = createNavigation();
    body.insertBefore(nav, firstChild);
}

// Add navigation when DOM is loaded
document.addEventListener('DOMContentLoaded', insertNavigation);