let touchSound = null;

function initTouchSound() {
    if (!touchSound) {
        touchSound = new Audio('/TW_Touch.ogg');
        touchSound.volume = 1;
        touchSound.load();
    }
}

function playTouchSound() {
    if (touchSound) {
        touchSound.currentTime = 0;
        touchSound.play().catch(e => console.log('Audio play prevented:', e));
    }
}

function goHome() {
    navigateTo('main')
}

function sanitizeImageUrl(url) {
    if (!url) return 'no.png';
    try {
        const parsed = new URL(url, window.location.origin)

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return 'no.png'
        }

        if (parsed.pathname.toLowerCase().endsWith('.svg')) {
            return 'no.png'
        }

        return parsed.href
    } catch {
        return 'no.png'
    }
}

function showPrompt(message, type = 'error') {
    const id = 'prompt-' + Date.now()
    const popup = document.createElement('div')
    popup.id = id
    popup.className = 'fixed bottom-6 left-4 p-3 rounded-lg font-medium text-sm text-white z-50 max-w-xs animate-fadeIn'
    
    if (type === 'error') {
        popup.style.background = 'rgba(239, 68, 68)'
    } else if (type === 'success') {
        popup.style.background = 'rgba(34, 197, 94)'
    } else {
        popup.style.background = 'rgba(59, 130, 246)'
    }
    
    popup.textContent = message
    document.body.appendChild(popup)
    
    setTimeout(() => {
        popup.remove()
    }, 4000)
}
function initTheme() {
    const savedTheme = localStorage.getItem('theme');

    window.spinnerHtml = function spinnerHtml(size = 28, color = 'currentColor') {
        return `<svg class="inline-block" width="${size}" height="${size}" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="25" cy="25" r="20" stroke="${color}" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.25"></circle>
            <path d="M45 25a20 20 0 00-6.6-14.6" stroke="${color}" stroke-width="5" stroke-linecap="round" fill="none">
                <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite"/>
            </path>
        </svg>`;
    };

    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
    } else if (savedTheme === 'light') {
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (prefersDark) {
            document.documentElement.classList.add('dark');
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('theme', 'dark');
        } else {
            document.documentElement.classList.remove('dark');
            document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('theme', 'light');
        }
    }

    document.body.classList.remove('dark');

    updateThemeIcons();
}

function toggleTheme() {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    if (isCurrentlyDark) {
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
    } else {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
    }

    document.body.classList.remove('dark');

    updateThemeIcons();
}
window.toggleTheme = toggleTheme;

function updateThemeIcons() {
    const text = document.getElementById('themeText')

    if (!text) return;
    const isDark = document.documentElement.classList.contains('dark');

    if (isDark) {
        text.textContent = 'Light Mode'
        document.getElementById('themeIconDark').classList.add('hidden');
        document.getElementById('themeIconLight').classList.remove('hidden');
    } else {
        text.textContent = 'Dark Mode'
        document.getElementById('themeIconLight').classList.add('hidden');
        document.getElementById('themeIconDark').classList.remove('hidden');
    }

    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

function checkAuth() {
    const token = localStorage.getItem('token');
    if (token) {
        showApp();
    } else {
        showAuth();
    }
}

function showAuth() {
    document.getElementById('authContainer').classList.remove('hidden');
    document.getElementById('appContainer').classList.add('hidden');
}

const API_BASE = ''

const DISCORD_CLIENT_ID = '1545967983678070816';

let discordAuthTried = false;
function inDiscordActivity() {
    const params = new URLSearchParams(location.search || '');
    return params.has('frame_id');
}

async function autoDiscordAuth() {
    if (discordAuthTried) return;
    discordAuthTried = true;
    try {
        const mod = await import('/discord-sdk/output/index.mjs');
        const { DiscordSDK } = mod;
        const sdk = new DiscordSDK(DISCORD_CLIENT_ID);
        await Promise.race([
            sdk.ready(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('SDK ready timed out')), 5000)),
        ]);
        const { code } = await sdk.commands.authorize({
            client_id: DISCORD_CLIENT_ID,
            response_type: 'code',
            state: '',
            prompt: 'none',
            scope: ['identify'],
        });
        if (!code) throw new Error('no authorization code');
        const res = await fetch(`${API_BASE}/api/discord/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            localStorage.setItem('auth.via', 'discord');
            showApp();
        } else {
            showPrompt(data.message || 'Discord sign-in failed (' + res.status + ')', 'error');
            if (!localStorage.getItem('token')) showAuth();
        }
    } catch (err) {
        console.warn('Discord activity auto-signup failed:', err);
        if (!localStorage.getItem('token')) showAuth();
    }
}


function showApp() {
    document.getElementById('authContainer').classList.add('hidden');
    document.getElementById('appContainer').classList.remove('hidden');
    navigateTo('main');
}

async function fetchConsoles(page = 1, append = false) {
    const token = localStorage.getItem('token')
    const grid = document.getElementById('consolesGrid')

    if (!append) {
        grid.innerHTML = `<div class="col-span-full text-center text-gray-600 dark:text-gray-400 flex items-center justify-center">${spinnerHtml(36)}</div>`
    } else {
        const loader = document.createElement('div')
        loader.id = 'projectsLoader'
        loader.className = 'col-span-full flex justify-center py-4'
        loader.innerHTML = spinnerHtml(24)
        grid.appendChild(loader)
    }

    try {
        const res = await fetch(`${API_BASE}/api/consoles`, {
            headers: { 'Authorization': token ? 'Bearer ' + token : '', 'Accept': 'application/json' }
        })
        const data = await res.json()

        document.getElementById('projectsLoader')?.remove()
        document.getElementById('loadMoreBtn')?.remove()

        if (!res.ok) {
            if (!append) grid.innerHTML = `<div class="col-span-full text-center text-red-500">${data.message || 'Failed to load consoles.'}</div>`
            return
        }

        if (!append) grid.innerHTML = ''

        const consoles = Array.isArray(data.consoles) ? data.consoles : Object.values(data.consoles || {})
        renderConsoles(consoles)
        if (!append) maybeShowHomeTutorial()
    } catch(err) {
        console.error('Consoles fetch error:', err)
        document.getElementById('projectsLoader')?.remove()
        if (!append) grid.innerHTML = '<div class="col-span-full text-center text-red-500">Failed to load consoles.</div>'
    }
}

function renderConsoles(consoles) {
    const grid = document.getElementById('consolesGrid')
    if (!grid) return
    if (!consoles?.length) {
        if (!grid.querySelector('.console-card')) {
            grid.innerHTML = '<div class="col-span-full text-center text-gray-600 dark:text-gray-400">No consoles found.</div>'
        }
        return
    }

    consoles.forEach(p => {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'console-card bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition cursor-pointer overflow-hidden'
        card.innerHTML = `
            <div class="console-image">
                <img src="${sanitizeImageUrl(p.image) || 'no.png'}" alt="${escapeHtml(p.name || 'Console')}" class="block w-full h-full object-cover stretched">
            </div>
            <div class="card-content">
                <div style="min-width:0;flex:1;">
                    <div class="card-title-wrap">
                        <div class="title text-gray-900 dark:text-white">${escapeHtml(p.name || 'Untitled')}</div>
                    </div>
                    <div class="plays" style="font-size:1rem;color:#6b7280;display:flex;align-items:center;gap:3px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                        </svg>
                        ${Array.isArray(p.players) ? p.players.length : (p.players || 0)}
                    </div>
                </div>
            </div>
        </div>
        `

        const cardImg = card.querySelector('img')
        if (cardImg) cardImg.addEventListener('error', () => { cardImg.src = 'no.png' })

        card.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            openConsoleViewer(p.name)
        })
        grid.appendChild(card)
        setTimeout(() => {
            const wrap = card.querySelector('.card-title-wrap')
            const title = card.querySelector('.card-title-wrap .title')
            if (wrap && title && title.scrollWidth > wrap.clientWidth) {
                title.classList.add('overflowing')
                wrap.style.setProperty('--scroll-distance', `${wrap.clientWidth - title.scrollWidth}px`)
            }
        }, 100)
    })
}

function timeAgo(ts) {
    const diff = Date.now() - ts
    const m = Math.floor(diff / 60000)
    const h = Math.floor(diff / 3600000)
    const d = Math.floor(diff / 86400000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    if (h < 24) return `${h}h ago`
    if (d < 30) return `${d}d ago`
    return new Date(ts).toLocaleDateString()
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
}

function showLogin() {
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('loginError').classList.add('hidden');
    document.getElementById('loginFormElement').reset();
}

function showRegister() {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('registerError').classList.add('hidden');
    document.getElementById('registerFormElement').reset();
}

document.addEventListener('DOMContentLoaded', () => {
    probeCodecSupport();
    initTheme();
    initTouchSound();
    checkAuth();
    buildMobileGamepad();
    bindMobileGamepad();
    applyGamepadVisibility();
    if (inDiscordActivity()) autoDiscordAuth();

    const loginFormEl = document.getElementById('loginFormElement');
    if (loginFormEl) {
        loginFormEl.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = document.getElementById('loginBtn');
            const originalText = submitBtn.innerHTML;

            submitBtn.disabled = true;
            submitBtn.innerHTML = spinnerHtml(20, 'white');
            
            const usernameInput = document.getElementById('loginusername') 
            const passwordInput = document.getElementById('loginpassword')
            const errorDiv = document.getElementById('loginError');

            if (!usernameInput || !passwordInput || !errorDiv) {
                console.error('login form elements missing');
                return;
            }

            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            try {
                const response = await fetch(`${API_BASE}/api/login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ username, password })
                });

                const data = await response.json();

                if (response.ok) {
                    if (data.token) {
                        localStorage.setItem('token', data.token);
                        localStorage.setItem('user', JSON.stringify(data.user));
                        localStorage.setItem('auth.via', 'normal');
                        showApp();
                        errorDiv.classList.add('hidden');
                    } else {
                        errorDiv.textContent = 'Login successful but no token received';
                        errorDiv.classList.remove('hidden');
                    }
                } else {
                    errorDiv.textContent = data.message || 'Login failed. Please check your credentials.';
                    errorDiv.classList.remove('hidden');
                }
            } catch (error) {
                console.error('Login error:', error);
                errorDiv.textContent = 'Network error. Please try again.';
                errorDiv.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
            }
        });
    }

    const registerFormEl = document.getElementById('registerFormElement');
    if (registerFormEl) {
        registerFormEl.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = document.getElementById('registerBtn');
            const originalText = submitBtn.innerHTML;

            submitBtn.disabled = true;
            submitBtn.innerHTML = spinnerHtml(20, 'white');
            
            const usernameInput = document.getElementById('registerusername')
            const passwordInput = document.getElementById('registerpassword')
            const errorDiv = document.getElementById('registerError');

            if (!usernameInput || !passwordInput || !errorDiv) {
                return;
            }

            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            try {
                const response = await fetch(`${API_BASE}/api/register`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ username, password })
                });

                const data = await response.json();

                if (response.ok) {
                    showLogin();
                    const loginError = document.getElementById('loginError');
                    if (loginError) {
                        loginError.textContent = 'Registration successful! Please login.';
                        loginError.classList.remove('text-red-500');
                        loginError.classList.add('text-green-500');
                        loginError.classList.remove('hidden');
                    }
                } else {
                    errorDiv.textContent = data.message || 'Registration failed. Please try again.';
                    errorDiv.classList.remove('hidden');
                }
            } catch (error) {
                console.error('registration error:', error);
                errorDiv.textContent = 'Network error. Please try again.';
                errorDiv.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
            }
        });
    }
});

document.addEventListener('click', (e) => {
    playTouchSound();
});

function navigateTo(page) {
    if (currentConsoleName && page !== 'consoleViewer') {
        closeConsoleViewer()
    }
    
    document.querySelectorAll('.page-content').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('bg-blue-50', 'dark:bg-gray-700', 'text-blue-600', 'dark:text-blue-400');
    });

    const pageElement = document.getElementById(page + 'Page');
    if (pageElement) {
        pageElement.classList.remove('hidden');
    }

    const navItem = document.querySelector(`[data-page="${page}"]`);
    if (navItem) {
        navItem.classList.add('bg-blue-50', 'dark:bg-gray-700', 'text-blue-600', 'dark:text-blue-400');
    }

    if (page === 'main') {
        fetchConsoles();
    }
}

function getCurrentUsername() {
    const token = localStorage.getItem('token')
    if (!token) return null
    try { return JSON.parse(atob(token.split('.')[1])).username } catch (_) { return null }
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('auth.via');
    stopStream();
    currentConsoleName = null;
    document.getElementById('consoleViewerPage')?.classList.add('hidden');
    showAuth();
    showLogin();
}

function closeRulesModal() {
    document.getElementById('rulesModal').classList.add('hidden')
}

function openRulesModal() {
    document.getElementById('rulesModal').classList.remove('hidden')
}

const TUTORIALS = {
    home: [
        { title: 'Welcome to emulatorSHARE', body: 'emulatorSHARE lets you play game consoles with strangers on the internet. Every card is a real emulator being hosted right now, streamed live into your browser.' },
        { title: 'Pick a console', body: 'Click any card to open it. The thumbnail on each card is a live snapshot of that console\'s screen, refreshed every 5 minutes while it\'s online.' },
        { title: 'Be cool', body: 'Please check and follow the rules at the top of the page: no harassment, no NSFW content, no toxicity, no breaking anything. Just pick a console and have fun.' },
    ],
    console: [
        { title: 'You\'re in!', body: 'This is the console\'s live screen, streaming in real time from the host machine.' },
        { title: 'Everyone shares the controls', body: 'Your keyboard and mouse feed into the same controller as everyone else.' },
        { title: 'Talk and coordinate', body: 'Use the chat to organize with other players and check the player list to see who\'s in the room. Now jump in!' },
    ],
};

let activeTutorial = null;
let tutorialIndex = 0;

function brandHTML(text) {
    return text.replace(/emulatorSHARE/g, '<span class="text-[#1E88E5]">emulator</span><span class="text-[#FF6B35]">SHARE</span>');
}

function tutorialSeenKey(id) {
    return `tutorial.seen.${id}.${getCurrentUsername() || 'guest'}`;
}
function tutorialAlreadySeen(id) {
    try { return localStorage.getItem(tutorialSeenKey(id)) === '1'; } catch { return false; }
}
function markTutorialSeen(id) {
    try { localStorage.setItem(tutorialSeenKey(id), '1'); } catch {}
}

function showTutorial(id) {
    const steps = TUTORIALS[id];
    if (!steps || !steps.length) return;
    activeTutorial = id;
    tutorialIndex = 0;
    renderTutorialStep();
    document.getElementById('tutorialModal').classList.remove('hidden');
}

function isDiscordAuthed() {
    try { return localStorage.getItem('auth.via') === 'discord'; } catch { return false; }
}

function maybeShowHomeTutorial() {
    if (isDiscordAuthed()) return;
    if (!tutorialAlreadySeen('home')) showTutorial('home');
}
function maybeShowConsoleTutorial() {
    if (isDiscordAuthed()) return;
    if (!tutorialAlreadySeen('console')) showTutorial('console');
}

function renderTutorialStep() {
    const steps = TUTORIALS[activeTutorial];
    if (!steps) return;
    const step = steps[tutorialIndex];
    document.getElementById('tutorialTitle').innerHTML = brandHTML(step.title);
    document.getElementById('tutorialBody').innerHTML = '<p class="text-gray-700 dark:text-gray-300 text-sm">' + brandHTML(step.body) + '</p>';
    document.getElementById('tutorialDots').innerHTML = steps.map((_, i) =>
        `<span class="w-2 h-2 rounded-full ${i === tutorialIndex ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}"></span>`).join('');
    document.getElementById('tutorialPrevBtn').classList.toggle('hidden', tutorialIndex === 0);
    document.getElementById('tutorialNextBtn').textContent =
        tutorialIndex === steps.length - 1 ? 'Done' : 'Next';
}

function tutorialNext() {
    const steps = TUTORIALS[activeTutorial];
    if (!steps) return;
    if (tutorialIndex < steps.length - 1) { tutorialIndex++; renderTutorialStep(); }
    else tutorialClose();
}
function tutorialPrev() {
    if (tutorialIndex > 0) { tutorialIndex--; renderTutorialStep(); }
}
function tutorialClose() {
    if (activeTutorial) markTutorialSeen(activeTutorial);
    document.getElementById('tutorialModal').classList.add('hidden');
    activeTutorial = null;
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('tutorialModal');
    if (modal && !modal.classList.contains('hidden')) {
        e.preventDefault();
        tutorialClose();
    }
});

// Delegated clicks for data-action buttons. Inline onclick="" attributes are
// silently ignored inside the Discord Activity embed, so all static UI buttons
// route through here instead.
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], [data-game-action]');
    if (!el) return;
    const gameAct = el.getAttribute('data-game-action');
    if (gameAct) {
        const game = el.getAttribute('data-game');
        if (gameAct === 'vote') { sendGameVote(game); return; }
        if (gameAct === 'cast') { sendGameCast(game, el.getAttribute('data-yes') === '1'); return; }
        return;
    }
    const act = el.getAttribute('data-action');
    if (act === 'startRemapCapture') { startRemapCapture(null); return; }
    const fn = window[act];
    if (typeof fn === 'function') fn.call(el, e);
});

// stuff
let currentConsoleName = null

async function openConsoleViewer(consoleName) {
    currentConsoleName = consoleName
    
    document.getElementById('mainPage').classList.add('hidden')
    document.getElementById('consoleViewerPage').classList.remove('hidden')
    applyGamepadVisibility()
    
    connectStreamWs(consoleName)
    setupChatForm()
    maybeShowConsoleTutorial()
}

function closeConsoleViewer() {
    stopStream();

    document.getElementById('consoleViewerPage').classList.add('hidden');
    document.getElementById('mainPage').classList.remove('hidden');
    
    currentConsoleName = null;
}

// ── WebSocket streaming (WebCodecs decode) ───────────────────────────────────
const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5 };

let streamWs = null;
let videoDecoder = null;
let decoderConfig = null;
let audioDecoder = null;
let audioCtx = null;
let audioUnlocked = false;
let playHead = 0;
let waitingForKeyframe = true;
let streamStatusEl = null;

// Full-host games (viewable + launchable on consoles that advertise them).
let gamesList = [];
let currentGameKey = null;
let gameVote = null;      // { game, by, yes:[..], no:[..], needed, endsAt } while open

function streamWsUrl(consoleName) {
    const token = localStorage.getItem('token') || '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.host || 'localhost:8090';
    return `${proto}//${host}/stream?token=${encodeURIComponent(token)}&console=${encodeURIComponent(consoleName)}`;
}

function connectStreamWs(consoleName) {
    setStreamStatus('connecting…');

    streamWs = new WebSocket(streamWsUrl(consoleName));
    streamWs.binaryType = 'arraybuffer';

    streamWs.onopen = () => {
        setStreamStatus('waiting for stream…');
        streamWs.send(JSON.stringify({ t: 'needkey' }));
    };

    streamWs.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
            // Binary media frame
            const buf = new Uint8Array(ev.data);
            if (buf.length < 9) return;
            const kind = buf[0];
            const dv = new DataView(ev.data);
            const timestamp = dv.getFloat64(1, true);
            const payload = buf.subarray(9);
            try {
                if (kind === KIND.VKEY || kind === KIND.VDELTA) decodeVideo(kind, timestamp, payload);
                else if (kind === KIND.ACHUNK) decodeAudio(timestamp, payload);
            } catch (e) { console.error('decode error:', e); }
            return;
        }

        // JSON control message
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        handleStreamMessage(msg);
    };

    streamWs.onclose = () => {
        setStreamStatus('disconnected - retrying…');
        waitingForKeyframe = true;
        if (currentConsoleName) {
            setTimeout(() => {
                if (currentConsoleName) connectStreamWs(currentConsoleName);
            }, 1500);
        }
    };

    streamWs.onerror = () => {};

    // Setup input forwarding on the canvas
    setupStreamInput();
}

function handleStreamMessage(msg) {
    switch (msg && msg.t) {
        case 'welcome':
            if (msg.error) {
                currentConsoleName = null;
                setStreamStatus('console is gone');
                if (streamWs) { try { streamWs.close(); } catch {} streamWs = null; }
                break;
            }
            if (msg.video) configureVideo(msg.video);
            if (msg.audio) configureAudio(msg.audio);
            if (Array.isArray(msg.games)) { gamesList = msg.games.slice(0, 50); currentGameKey = msg.current || null; renderGames(); }
            if (!msg.host) setStreamStatus('console is booting…');
            else setStreamStatus('');
            break;
        case 'vconfig':
            configureVideo(msg.config);
            break;
        case 'aconfig':
            configureAudio(msg.config);
            break;
        case 'host':
            setStreamStatus(msg.up ? '' : 'console went down - it will come back');
            if (msg.up) waitingForKeyframe = true;
            break;
        case 'roster':
            updatePlayerList(msg.users || []);
            break;
        case 'chat':
            if (msg.from && msg.text) addChatMessage(msg.from, msg.text, false, false, null);
            break;
        case 'games':
            gamesList = Array.isArray(msg.games) ? msg.games.slice(0, 50) : [];
            currentGameKey = msg.current || null;
            renderGames();
            break;
        case 'gamevote':
            if (msg.open) {
                const yes = (msg.yes || []).map((u) => u.name);
                const no = (msg.no || []).map((u) => u.name);
                gameVote = { game: msg.game, by: msg.by, yes, no, needed: msg.needed, endsAt: msg.endsAt || 0 };
            } else {
                gameVote = null;
            }
            renderGames();
            break;
        case 'gamestate':
            if (msg.state && msg.state.game) currentGameKey = msg.state.game;
            renderGames();
            break;
    }
}

// ── Games panel (full-host consoles) ────────────────────────────────────────
function renderGames() {
    const panel = document.getElementById('gamesPanel');
    const box = document.getElementById('gamesBox');
    if (!panel || !box) return;
    const visible = gamesList.length > 0 || gameVote || currentGameKey;
    panel.classList.toggle('hidden', !visible);
    if (!visible) return;

    let html = '<div class="flex items-center justify-between mb-2">';
    html += '<h3 class="dark:text-white text-black font-medium">Games</h3>';
    const running = gamesList.find((g) => g.key === currentGameKey);
    if (currentGameKey) {
        html += '<span class="text-xs font-mono px-2 py-1 rounded bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">now: ' + escapeHtml(running ? running.name : currentGameKey) + '</span>';
    }
    html += '</div>';

    if (gamesList.length) {
        html += '<div class="flex flex-wrap gap-2">';
        for (const g of gamesList) {
            const isRun = g.key === currentGameKey;
            html += '<button data-game-action="vote" data-game="' + escapeHtml(g.key) + '" class="' +
                (isRun ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700') +
                ' text-white text-sm font-medium px-3 py-1.5 rounded-md transition-colors" ' +
                (isRun ? 'disabled' : '') + '>' + escapeHtml(g.name) + '</button>';
        }
        html += '</div>';
    }

    if (gameVote) {
        const now = Date.now();
        const secs = Math.max(0, Math.round(((gameVote.endsAt || now) - now) / 1000));
        const yesN = gameVote.yes.length, noN = gameVote.no.length, need = gameVote.needed || 1;
        const total = yesN + noN;
        const pct = (total > 0 ? Math.round((yesN / total) * 100) : 0);
        html += '<div class="mt-3 pt-3 border-t border-gray-300 dark:border-gray-600">';
        html += '<div class="text-sm dark:text-gray-200 text-gray-800 mb-1">';
        html += escapeHtml(gameVote.by) + ' wants to launch <b>' + escapeHtml((gamesList.find((g) => g.key === gameVote.game) || {}).name || gameVote.game) + '</b>';
        html += ' <span class="text-xs text-gray-500 dark:text-gray-400">(' + yesN + '/' + need + ' needed' + (secs ? ' · ' + secs + 's' : '') + ')</span></div>';
        html += '<div class="h-2 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden mb-2">';
        html += '<div class="h-full bg-blue-500" style="width:' + Math.min(100, pct) + '%"></div></div>';
        html += '<div class="flex gap-2">';
        html += '<button data-game-action="cast" data-game="' + escapeHtml(gameVote.game) + '" data-yes="1" class="bg-green-600 hover:bg-green-700 text-white text-xs font-medium px-3 py-1 rounded-md transition-colors">Yes (' + yesN + ')</button>';
        html += '<button data-game-action="cast" data-game="' + escapeHtml(gameVote.game) + '" data-yes="0" class="bg-red-600 hover:bg-red-700 text-white text-xs font-medium px-3 py-1 rounded-md transition-colors">No (' + noN + ')</button>';
        html += '</div></div>';
    }

    box.innerHTML = html;
}

function sendGameVote(game) {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) return;
    streamWs.send(JSON.stringify({ t: 'gamevote', game }));
}
function sendGameCast(game, yes) {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) return;
    streamWs.send(JSON.stringify({ t: 'gamecast', game, yes }));
}

function setStreamStatus(text) {
    if (!streamStatusEl) streamStatusEl = document.getElementById('streamStatus');
    if (!streamStatusEl) return;
    streamStatusEl.textContent = text || '';
    streamStatusEl.classList.toggle('hidden', !text);
}

function decoderErrorMsg(e) {
    if (!e) return '(unknown)';
    const m = e && e.message ? String(e.message) : '';
    const n = e && e.name ? String(e.name) : '';
    if (m && n) return n + ': ' + m;
    return m || n || String(e);
}

function stopStream() {
    if (streamWs) { try { streamWs.close(); } catch {} streamWs = null; }
    if (videoDecoder && videoDecoder.state !== 'closed') { try { videoDecoder.close(); } catch {} videoDecoder = null; }
    if (audioDecoder && audioDecoder.state !== 'closed') { try { audioDecoder.close(); } catch {} audioDecoder = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; audioUnlocked = false; }
    waitingForKeyframe = true;
}

// ── Video decoding (WebCodecs) ───────────────────────────────────────────────
function b64ToBuf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function getStreamCanvas() {
    return document.getElementById('consoleCanvas');
}

let decoderProbe = null;

async function probeCodecSupport() {
    if (decoderProbe) return decoderProbe;
    if (typeof VideoDecoder === 'undefined') {
        console.warn('[probe] VideoDecoder API is NOT available in this browser');
        return [];
    }
    const candidates = [
        { codec: 'avc1.42E01F' },
        { codec: 'avc1.4D401F' },
        { codec: 'avc1.64001F' },
        { codec: 'vp8' },
        { codec: 'vp9' },
        { codec: 'h264' },
        { codec: 'hevc' },
    ];
    const results = [];
    for (const c of candidates) {
        try {
            const s = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: 782, codedHeight: 614 });
            results.push({ codec: c.codec, supported: !!(s && s.supported) });
            console.warn(`[probe] ${c.codec} => supported=${!!(s && s.supported)}`);
        } catch (e) {
            results.push({ codec: c.codec, supported: false });
            console.warn(`[probe] ${c.codec} => threw: ${e && e.message}`);
        }
    }
    decoderProbe = results;
    return results;
}

function decodeSupportStatus() {
    if (!decoderProbe || !decoderProbe.length) return '';
    return ' [browser supports: ' + decoderProbe.map(p => p.codec + (p.supported ? '✓' : '✗')).join(' ') + ']';
}

async function configureVideo(config) {
    if (!config || !config.codec) return;
    try { if (videoDecoder && videoDecoder.state !== 'closed') videoDecoder.close(); } catch {}

    const canvas = getStreamCanvas();
    let ctx = canvas.getContext('2d');
    if (ctx) ctx.imageSmoothingEnabled = false;

// Optional CSS container size from the host (--cw / --ch). The canvas fills
    // the container via w-full/h-full object-contain, so these set the visible
    // box. If only one dimension is given, the other derives from the stream
    // aspect ratio so nothing gets squished.
    if (config.viewWidth || config.viewHeight) {
        const box = document.getElementById('consoleViewerContainer');
        if (box) {
            const cw = config.codedWidth || 640;
            const ch = config.codedHeight || 480;
            const vw = Number(config.viewWidth) || 0;
            const vh = Number(config.viewHeight) || 0;
            if (vw && vh) { box.style.width = `${vw}px`; box.style.height = `${vh}px`; }
            else if (vw) { box.style.width = `${vw}px`; box.style.height = `${Math.round(vw * ch / cw)}px`; }
            else if (vh) { box.style.height = `${vh}px`; box.style.width = `${Math.round(vh * cw / ch)}px`; }
        }
    }

    decoderConfig = {
        codec: config.codec,
        codedWidth: config.codedWidth || 640,
        codedHeight: config.codedHeight || 480,
        optimizeForLatency: true,
        // Force the software decoder: GPU/hardware VP8 & H.264 decode paths are
        // flaky on some Windows drivers and periodically emit "Decoding error",
        // which is exactly the intermittent failure this fixes. Software decode
        // of a 640x480 VP8 stream is cheap (near-zero CPU cost).
        hardwareAcceleration: 'prefer-software',
    };
    // Provide the avcC `description` so the decoder knows lengthSizeMinusOne=4
    // (byte 0xFF in the record) and can parse the 4-byte-length avcC chunks we
    // feed it. The SPS inside is now valid (0x67 header intact after the
    // normalize fix), so the description is correct and Chrome can decode.
    if (config.description) decoderConfig.description = b64ToBuf(config.description);

    console.log('[decoder] config -> isConfigSupported:', JSON.stringify({
        codec: decoderConfig.codec,
        codedWidth: decoderConfig.codedWidth,
        codedHeight: decoderConfig.codedHeight,
        description_b64: config.description,
        description_bytes: config.description ? b64ToBuf(config.description).length : null,
    }));

    try {
        const support = await VideoDecoder.isConfigSupported(decoderConfig);
        console.log('[decoder] isConfigSupported RESULT:', JSON.stringify({ supported: !!(support && support.supported), error: support && support.error ? String(support.error.message || support.error) : (support && support.config ? JSON.stringify(support.config) : null) }));
        if (!support || !support.supported) {
            const reason = support && support.error ? String(support.error.message || support.error) : '(no error detail)';
            console.warn('[decoder] isConfigSupported rejected:', JSON.stringify({
                codec: decoderConfig.codec,
                codedWidth: decoderConfig.codedWidth,
                codedHeight: decoderConfig.codedHeight,
                hasDescription: !!decoderConfig.description,
                reason,
            }));
            setStreamStatus(`browser can't decode ${config.codec} (${reason})` + decodeSupportStatus());
            return;
        }
    } catch (e) {
        console.warn('[decoder] isConfigSupported threw:', e);
        setStreamStatus(`browser can't decode ${config.codec}` + decodeSupportStatus());
        return;
    }

    __decoderOutputFn = (videoFrame) => {
        // NO per-frame console.log here: console output is slow, and logging on
        // every N frames is throttled/serialized when the viewer tab is
        // backgrounded, which stalls the decode→draw pipeline → visible lag.
        if (window.__dbgOutput === undefined) window.__dbgOutput = 0;
        window.__dbgOutput++;
        try {
            if (canvas.width !== videoFrame.displayWidth || canvas.height !== videoFrame.displayHeight) {
                canvas.width = videoFrame.displayWidth;
                canvas.height = videoFrame.displayHeight;
                ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = false; // crisp retro pixels, no blur/tear-smear
            }
            ctx.drawImage(videoFrame, 0, 0);
        } catch (err) {
            console.error('[decoder DRAW ERROR]', err);
        }
        videoFrame.close();
        setStreamStatus('');
        if (window.__dbgOutput === 3) setStreamStatus('Frames rendering (' + window.__dbgOutput + ')');
    };
    __decoderErrorFn = (e) => {
        console.error('[decoder ERROR]', e);
        waitingForKeyframe = true;
        const errText = decoderErrorMsg(e);
        setStreamStatus('decode error (' + errText + ') - waiting for keyframe' + decodeSupportStatus());
        // Chrome reports configs as supported that then fail to instantiate,
        // especially H.264 with hardwareAcceleration:'prefer-software' inside
        // embedded host apps (Discord Activity) where the software H.264 path
        // doesn't exist. Fall back to the default hint and retry with a new
        // decoder + fresh keyframe.
        const unsupported = /unsupported configuration|not supported|invalid config/i.test(errText);
        if (unsupported && decoderConfig && decoderConfig.hardwareAcceleration === 'prefer-software') {
            const retry = { ...decoderConfig };
            retry.hardwareAcceleration = 'no-preference';
            decoderConfig = retry;
            console.warn('[decoder] "Unsupported configuration" with prefer-software; retrying with no-preference');
            setStreamStatus('decode retrying without the prefer-software hint…');
            try {
                videoDecoder = new VideoDecoder({ output: __decoderOutputFn, error: __decoderErrorFn });
                videoDecoder.configure(decoderConfig);
            } catch (err2) {
                console.error('[decoder] fallback configure failed', err2);
            }
        } else if (decoderConfig) {
            try { if (videoDecoder && videoDecoder.state !== 'closed') videoDecoder.configure(decoderConfig); } catch {}
        }
        // Ask the host to force a fresh keyframe NOW (restart the encoder) so we
        // resync immediately instead of freezing until the next natural GOP.
        requestHardKeyframe();
    };

    videoDecoder = new VideoDecoder({ output: __decoderOutputFn, error: __decoderErrorFn });
    videoDecoder.configure(decoderConfig);
    waitingForKeyframe = true;
    // No description-harvesting: when the host sends no avcC description we decode
    // raw Annex-B byte-stream (SPS/PPS inline with each IDR), same as the
    // arena/desktop agent. Request a keyframe so we start on a clean IDR.
    needAvcDescription = false;
    if (streamWs && streamWs.readyState === 1) streamWs.send(JSON.stringify({ t: 'needkey' }));
}

// Tracked in configureVideo(); set when the host sent no avcC description and we
// must extract SPS/PPS from the first keyframe to build one.
let needAvcDescription = false;
let __decoderOutputFn = null, __decoderErrorFn = null;
let __lastKeyframePayload = null;
function ensureAvcDescription() {
    if (!needAvcDescription || !decoderConfig) return false;
    const nals = annexBNals(__lastKeyframePayload);
    if (!nals) return false;
    let sps = null, pps = null;
    for (const nal of nals) {
        if (nal.type === 7 && !sps) sps = nal.bytes;
        else if (nal.type === 8 && !pps) pps = nal.bytes;
    }
    __lastKeyframePayload = null;
    if (!sps || !pps) { console.warn('[decoder] keyframe had no SPS/PPS'); return false; }
    decoderConfig.description = buildAvcDescription(sps, pps);
    needAvcDescription = false;
    console.log('[decoder] built avcC description from keyframe (' + sps.length + '/' + pps.length + ' bytes) - reconfiguring');
    console.log('[decoder] SPS[0..3]=', Array.from(sps.slice(0, 4)), ' PPS=', Array.from(pps));
    try { if (videoDecoder && videoDecoder.state !== 'closed') videoDecoder.close(); } catch {}
    try { videoDecoder = new VideoDecoder({ output: __decoderOutputFn, error: __decoderErrorFn }); videoDecoder.configure(decoderConfig); } catch (e) { console.error('[decoder] reconfigure failed', e); return false; }
    waitingForKeyframe = true;
    // Request a fresh keyframe so we decode a clean IDR, not the in-flight one
    // (its SPS/PPS were just consumed to build the description).
    if (streamWs && streamWs.readyState === 1) streamWs.send(JSON.stringify({ t: 'needkey' }));
    return true;
}

const MAX_DECODE_QUEUE = 8;

function requestKeyframe() {
    // Routine request - the host's natural `-g fps` keyframes (every second)
    // already cover resync, so this only nudges it along. The host does NOT
    // restart its encoder for plain `needkey`.
    if (streamWs && streamWs.readyState === 1) streamWs.send(JSON.stringify({ t: 'needkey' }));
}

function requestHardKeyframe() {
    // Urgent request after a decode error - the host restarts its video encoder,
    // which re-emits a brand-new keyframe immediately.
    if (streamWs && streamWs.readyState === 1) streamWs.send(JSON.stringify({ t: 'hardkey' }));
}

function decodeVideo(kind, timestamp, payload) {
    if (!videoDecoder || videoDecoder.state !== 'configured') return;
    if (!payload || payload.length === 0) return;   // decoder throws on empty buffers
    const isKey = kind === KIND.VKEY;
    const q = videoDecoder.decodeQueueSize;
    // Back-pressure: keep decode latency bounded by dropping frames when the
    // decoder queue grows.  Every queued frame adds ~33 ms of latency at 30
    // fps; an MAX_DECODE_QUEUE of 8 caps decode-only lag to ~270 ms.
    //  - queue > 4: skip delta frames (cheap to drop, expensive to decode)
    //  - queue > MAX_DECODE_QUEUE: drop everything, seek next keyframe
    // Whenever we drop, ask the host to force a keyframe so the picture snaps
    // to the latest frame immediately instead of freezing on the last decoded
    // frame until the next natural keyframe (up to 2s at 30fps).
    if (q > MAX_DECODE_QUEUE) {
        // Decoder is overwhelmed - reset drops ALL queued work (old frames)
        // instantly so we resync on the incoming keyframe instead of decoding
        // 8+ stale frames behind it. Reset clears the codec state, so we must
        // wait for a fresh keyframe afterward.
        try { videoDecoder.reset(); } catch {}
        waitingForKeyframe = true;
        if (isKey) waitingForKeyframe = false;
        requestKeyframe();
        return;
    }
    if (q > 4 && !isKey) {
        // High latency. We must NOT skip JUST this delta: in VP8 every delta
        // references the previously decoded frame, so dropping one breaks the
        // reference chain and the next delta fails with a decode error. Instead
        // drop everything until the next keyframe and ask the host for one, so
        // the chain is rebuilt cleanly on an intra frame.
        waitingForKeyframe = true;
        requestKeyframe();
        return;
    }
    if (waitingForKeyframe && !isKey) return;
    if (isKey) {
        waitingForKeyframe = false;
        if (needAvcDescription) {
            // Host sent no avcC description (Edge omits it for avc1). Pull the
            // SPS/PPS out of this keyframe, build the description, and
            // reconfigure once. Return early: wait for the freshly requested
            // keyframe instead of decoding this in-flight one.
            __lastKeyframePayload = payload;
            if (ensureAvcDescription()) return;
        }
    }
    try {
        let data;
        if (decoderConfig && decoderConfig.codec && /^avc/.test(decoderConfig.codec)) {
            // H.264. When the host supplied an avcC `description` we convert the
            // Annex-B AU to length-prefixed avcC and drop the redundant inline
            // SPS/PPS/SEI. When it did not (like the arena/desktop host), feed
            // the raw Annex-B byte-stream — Chrome reads SPS/PPS directly out of
            // each IDR and needs no description or conversion.
            if (decoderConfig.description) {
                const clean = isKey ? stripParamSets(payload) : payload;
                data = annexBToAvcC(clean || payload);
            } else {
                data = payload;
            }
        } else {
            // VP8/VP9/AV1: feed the raw chunk; no annex-B conversion or description.
            data = payload;
        }
        if (window.__dbgCount === undefined) window.__dbgCount = 0;
        if (window.__dbgCount++ < 15) {
            console.log(`[decode] rawKind=${kind} type=${isKey ? 'key' : 'delta'} payload=${payload.length} feed=${data.length} codec=${decoderConfig && decoderConfig.codec} ts=${timestamp} q=${videoDecoder.decodeQueueSize}`);
        }
        videoDecoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data }));
        if (isKey) scheduleNoOutputCheck();
    } catch { waitingForKeyframe = true; }
}

// If we've decoded keyframes but the decoder never produced a frame, the decoder
// is silently wedged (SPS/description mismatch). Reconfigure + request a fresh
// keyframe once. This flag keeps us from hammering reconfigures each GOP.
let __noOutputArmed = false;
function scheduleNoOutputCheck() {
    if (__noOutputArmed) return;
    __noOutputArmed = true;
    if (window.__outCount === undefined) window.__outCount = 0;
    window.__outCount++;
    if (window.__outCount > 1) { __noOutputArmed = false; return; }
    setTimeout(() => {
        __noOutputArmed = false;
        if (videoDecoder && (window.__dbgOutput || 0) === 0) {
            console.warn('[decoder] WATCHDOG: keyframes decoded but no output - reconfiguring');
            waitingForKeyframe = true;
            if (decoderConfig) {
                try { videoDecoder.configure(decoderConfig); } catch {}
            }
            if (streamWs && streamWs.readyState === 1) streamWs.send(JSON.stringify({ t: 'needkey' }));
        }
    }, 3000);
}

// Count start-code-delimited NAL units in an annex-b buffer.
function countNals(payload) {
    const data = payload;
    let c = 0;
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) { c++; }
    }
    return c;
}

// Convert a raw annex-b H.264 bitstream (00 00 00 01 / 00 00 01 start codes) to
// avcC format (4-byte big-endian NAL length prefixes), which is what the
// browser's VideoDecoder expects when configured with an avc1 codec + avcC.
// The host sends one complete NAL per WS frame, so each frame yields its NAL.
function annexBToAvcC(payload) {
    const out = [];
    const data = payload;
    const n = data.length;
    const isStart = (p) => {
        if (p + 3 < n && data[p] === 0 && data[p + 1] === 0 && data[p + 2] === 1) return 3;
        if (p + 4 < n && data[p] === 0 && data[p + 1] === 0 && data[p + 2] === 0 && data[p + 3] === 1) return 4;
        return 0;
    };

    let lastSc = -1;
    let i = 0;
    while (i + 3 < n) {
        const scLen = isStart(i);
        if (scLen) {
            if (lastSc >= 0) {
                const nbody = i - lastSc;
                if (nbody > 0) {
                    const chunk = new Uint8Array(4 + nbody);
                    new DataView(chunk.buffer).setUint32(0, nbody, false);
                    chunk.set(data.subarray(lastSc, i), 4);
                    out.push(chunk);
                }
            }
            lastSc = i + scLen;
            i += scLen;
        } else {
            i++;
        }
    }

    // Flush the trailing NAL (a complete NAL: bytes after the last start code).
    if (lastSc >= 0) {
        const tail = data.slice(lastSc);
        if (tail.length > 1) {
            const chunk = new Uint8Array(4 + tail.length);
            new DataView(chunk.buffer).setUint32(0, tail.length, false);
            chunk.set(tail, 4);
            out.push(chunk);
        }
    }

    if (out.length === 0) return new Uint8Array(0);
    let total = 0;
    for (const c of out) total += c.length;
    const result = new Uint8Array(total);
    let o = 0;
    for (const c of out) { result.set(c, o); o += c.length; }
    return result;
}

// Split an annex-b H.264 buffer into NAL units (each WITHOUT start code) so we
// can pull the SPS (type 7) / PPS (type 8) out of a keyframe.
function annexBNals(payload) {
    const data = payload;
    const n = data.length;
    const nals = [];
    let i = 0;
    while (i + 3 < n) {
        let sc = 0;
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (i + 3 === n || data[i + 3] !== 0)) sc = 3;
        else if (i + 4 < n && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) sc = 4;
        if (!sc) { i++; continue; }
        const start = i + sc;
        let j = start;
        while (j + 3 < n) {
            if (data[j] === 0 && data[j + 1] === 0 && data[j + 2] === 1 && (j + 3 === n || data[j + 3] !== 0)) break;
            if (j + 4 < n && data[j] === 0 && data[j + 1] === 0 && data[j + 2] === 0 && data[j + 3] === 1) break;
            j++;
        }
        nals.push({ type: data[start] & 0x1f, bytes: data.slice(start, j) });
        i = j;
    }
    return nals;
}

// Build an avcC "description" blob from SPS + PPS NALs so the browser's avc1
// VideoDecoder can be configured with it (needed when the host's keyframes carry
// SPS/PPS inline but the encoder never emitted a decoderConfig description -
// which is exactly what Edge does for avc1).
function buildAvcDescription(sps, pps) {
    const out = [];
    const u16 = (v) => { out.push(v >> 8 & 0xff, v & 0xff); };
    // sps[0] is the NAL-type header byte (0x67); the profile/compat/level live
    // at sps[1..3] in that order, so copy those — a shifted description (profile
    // byte = 0x67) is rejected by strict decoders.
    out.push(0x01, sps[1] || 0, sps[2] || 0, sps[3] || 0);  // version, profile, compat, level
    out.push(0xfc | 0x03);              // lengthSizeMinusOne = 3 (4-byte lengths)
    out.push(0xe0 | 1);                 // 1 SPS
    u16(sps.length); for (const b of sps) out.push(b);
    out.push(1);                        // 1 PPS
    u16(pps.length); for (const b of pps) out.push(b);
    return new Uint8Array(out);
}

// Remove SPS(type 7)/PPS(type 8)/SEI(type 6) NALs from an annex-b buffer,
// preserving the exact bytes (start code + body) of everything else. Once the
// decoder has an avcC description, carrying SPS/PPS inline too can confuse
// strict decoders, so we drop only those and keep the IDR as the encoder made it.
function stripParamSets(payload) {
    const data = payload;
    const n = data.length;
    const nals = [];
    let i = 0;
    while (i + 3 < n) {
        let sc = 0;
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (i + 3 === n || data[i + 3] !== 0)) sc = 3;
        else if (i + 4 < n && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) sc = 4;
        if (!sc) { i++; continue; }
        const bodyStart = i + sc;
        let j = bodyStart;
        while (j + 3 < n) {
            const is3 = data[j] === 0 && data[j + 1] === 0 && data[j + 2] === 1 && (j + 3 === n || data[j + 3] !== 0);
            const is4 = j + 4 < n && data[j] === 0 && data[j + 1] === 0 && data[j + 2] === 0 && data[j + 3] === 1;
            if (is3 || is4) break;
            j++;
        }
        nals.push({ type: data[i + sc] & 0x1f, from: i, bodyStart, end: j });
        i = j;
    }
    const keep = nals.filter((s) => s.type !== 7 && s.type !== 8 && s.type !== 6);
    if (keep.length === nals.length || keep.length === 0) return payload;
    const out = [];
    for (let k = 0; k < keep.length; k++) {
        const s = keep[k];
        // start code bytes [from, bodyStart) + body bytes [bodyStart, end)
        out.push(...data.slice(s.from, s.bodyStart));
        out.push(...data.slice(s.bodyStart, s.end));
    }
    return new Uint8Array(out);
}

// ── Audio decoding (WebCodecs + Web Audio) ───────────────────────────────────
const JITTER_S = 0.10;
const MAX_AUDIO_LEAD_S = 0.45;

async function configureAudio(config) {
    if (!config || !config.codec) return;
    try { if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close(); } catch {}

    const decoderConfig = {
        codec: config.codec,
        sampleRate: config.sampleRate || 48000,
        numberOfChannels: config.numberOfChannels || 2,
    };
    if (config.description) decoderConfig.description = b64ToBuf(config.description);

    try {
        const support = await AudioDecoder.isConfigSupported(decoderConfig);
        if (!support || !support.supported) { setStreamStatus(`browser can't decode ${config.codec}`); return; }
    } catch {}

    audioDecoder = new AudioDecoder({
        output: (audioData) => {
            if (!audioUnlocked || !audioCtx) { audioData.close(); return; }
            try {
                const channels = audioData.numberOfChannels;
                const frames = audioData.numberOfFrames;
                const buf = audioCtx.createBuffer(channels, frames, audioData.sampleRate);
                for (let c = 0; c < channels; c++) {
                    const tmp = new Float32Array(frames);
                    audioData.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
                    buf.copyToChannel(tmp, c);
                }
                const src = audioCtx.createBufferSource();
                src.buffer = buf;
                src.connect(audioCtx.destination);
                const now = audioCtx.currentTime;
                if (playHead < now + 0.01) playHead = now + JITTER_S;
                if (playHead - now > MAX_AUDIO_LEAD_S) {
                    // Burst arrived (e.g. a full Ogg page at once). Still play it so
                    // audio is gapless; re-anchor keeps the queue from growing forever.
                    playHead = now + JITTER_S;
                }
                src.start(playHead);
                playHead += buf.duration;
            } catch {}
            audioData.close();
        },
        error: () => {},
    });
    audioDecoder.configure(decoderConfig);
}

function decodeAudio(timestamp, payload) {
    if (!audioDecoder || audioDecoder.state !== 'configured') return;
    if (!payload || payload.length === 0) return;   // decoder throws on empty buffers
    try { audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: payload })); } catch {}
}

function unlockAudio() {
    if (audioUnlocked) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        audioUnlocked = true;
        playHead = 0;
    } catch (err) { console.warn('audio unlock failed', err); }
}

// ── Input forwarding ────────────────────────────────────────────────────────
// Track which buttons are currently pressed on this viewer. A held button must
// not repeat clicks: one physical press → exactly one click message. The button
// is cleared on mouseup/leave so the next press can click again.
const _heldButtons = new Set();

// ── Pointer-lock camera mode ────────────────────────────────────────────────
// Backtick (`) toggles "camera" mode: the cursor is hidden and pointer-locked
// (invisible and recentered by the browser), and only mouse *deltas*
// (movementX/Y) are forwarded as relative motion. Games like Minecraft need
// this for proper camera look; absolute cursor coordinates are useless there.
let cameraActive = false;

function toggleCameraMode() {
    if (cameraActive) exitCameraMode(); else enterCameraMode();
}
function enterCameraMode() {
    const canvas = getStreamCanvas();
    if (!canvas || cameraActive) return;
    cameraActive = true;
    if (canvas.style) canvas.style.cursor = 'none';
    try {
        const p = canvas.requestPointerLock && canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { }
    updateCameraBadge();
}
function exitCameraMode() {
    if (!cameraActive) return;
    cameraActive = false;
    const canvas = getStreamCanvas();
    if (canvas && canvas.style) canvas.style.cursor = '';
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch { } }
    updateCameraBadge();
}
function updateCameraBadge() {
    const b = document.getElementById('cameraBadge');
    if (b) b.classList.toggle('hidden', !cameraActive);
}
// Pointer lock dropping out (Esc, switching tabs/minimizing) ends camera mode
// so the now-visible cursor lines back up with normal absolute mouse handling.
document.addEventListener('pointerlockchange', () => {
    if (cameraActive && !document.pointerLockElement) exitCameraMode();
});

function setupStreamInput() {
    const canvas = getStreamCanvas();
    if (!canvas) return;

    const pos = (e, target) => {
        const rect = target.getBoundingClientRect();
        return {
            x: Math.round(((e.clientX - rect.left) / rect.width) * target.width),
            y: Math.round(((e.clientY - rect.top) / rect.height) * target.height),
        };
    };

    canvas.addEventListener('mousemove', (e) => {
        if (cameraActive) {
            sendStreamInput({ mouse: { dx: e.movementX || 0, dy: e.movementY || 0, rel: true } });
            return;
        }
        const p = pos(e, canvas);
        sendStreamInput({ mouse: { x: p.x, y: p.y } });
    });
    canvas.addEventListener('mousedown', (e) => {
        unlockAudio();
        const btn = e.button + 1;
        if (_heldButtons.has(btn)) return;   // already holding → no re-click
        _heldButtons.add(btn);
        if (cameraActive) {
            sendStreamInput({ mouse: { dx: 0, dy: 0, rel: true, click: true, button: btn } });
            return;
        }
        const p = pos(e, canvas);
        sendStreamInput({ mouse: { x: p.x, y: p.y, click: true, button: btn } });
    });
    canvas.addEventListener('mouseup', (e) => {
        const btn = e.button + 1;
        _heldButtons.delete(btn);
        if (cameraActive) {
            sendStreamInput({ mouse: { dx: 0, dy: 0, rel: true } });
            return;
        }
        const p = pos(e, canvas);
        sendStreamInput({ mouse: { x: p.x, y: p.y } });   // release: stop any hold
    });
    // If the pointer leaves while held (or focus is lost), treat as released so
    // the button never stays stuck down for other viewers.
    canvas.addEventListener('mouseleave', () => {
        if (_heldButtons.size) {
            _heldButtons.clear();
            sendStreamInput({ mouse: null }); // just keys; host's auto-mouseup fires
        }
    });
}

// Coalesce/dedupe input: remember the last mouse position we forwarded and the
// time we forwarded it, so we never re-send an identical position repeatedly
// (prevents "keeps relaying the same input" even if mousemove fires in a loop,
// e.g. a SetCursorPos feedback loop warping the OS cursor back over the canvas).
let _lastMouseSent = null;
let _lastMouseAt = 0;
const _MOUSE_MIN_GAP_MS = 16;

function sendStreamInput(msg) {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) return;

    const m = msg.mouse || null;
    if (m) {
        const now = Date.now();
        // Clicks must go through immediately.
        if (m.click) {
            flushInput(msg);
            return;
        }
        // Too soon after the previous send (rapid mousemove storm) - drop.
        if (now - _lastMouseAt < _MOUSE_MIN_GAP_MS) return;
        if (m.rel) {
            // Camera mode: forward deltas, skip identical (zero-move) repeats.
            if (_lastMouseSent && _lastMouseSent.rel && _lastMouseSent.dx === m.dx && _lastMouseSent.dy === m.dy) {
                return;
            }
            _lastMouseAt = now;
            _lastMouseSent = { dx: m.dx, dy: m.dy, rel: true };
            flushInput({ mouse: { dx: m.dx, dy: m.dy, rel: true } });
            return;
        }
        // Identical position to what we already sent - nothing new, drop it.
        // This is the key guard against a "replays same input" feedback loop.
        if (_lastMouseSent && _lastMouseSent.x === m.x && _lastMouseSent.y === m.y) {
            return;
        }
        _lastMouseAt = now;
        _lastMouseSent = { x: m.x, y: m.y };
        flushInput({ mouse: { x: m.x, y: m.y } });
    } else {
        flushInput(msg);
    }
}

function flushInput(msg) {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) return;
    streamWs.send(JSON.stringify({
        t: 'input',
        keys: msg.keys !== undefined ? msg.keys : effectiveHeldKeys(),
        mouse: msg.mouse || null,
    }));
}

// Key chords: when every code in a chord's `keys` is held at the same time,
// forward the chord's `to` code instead of the individual keys (raw e.code
// values, applied after any remaps). Lets G+H act as F1.
const KEY_CHORDS = [
    { keys: ['KeyG', 'KeyH'], to: 'F1' },
];
function effectiveHeldKeys() {
    const out = new Set();
    for (const code of heldInputKeys) {
        const consumed = KEY_CHORDS.some((c) => c.keys.includes(code) && c.keys.every((k) => heldInputKeys.has(k)));
        if (!consumed) out.add(code);
    }
    for (const c of KEY_CHORDS) {
        if (c.keys.every((k) => heldInputKeys.has(k))) out.add(c.to);
    }
    return [...out];
}

// ── Key remapping (PC) + on-screen gamepad (mobile) ──────────────────────────
// Users can remap physical keys to other keys (stored in localStorage) and get
// an on-screen pad on touch devices. Both feed the same setInputKey path, so a
// remap also applies to the mobile pad (e.g. bind Y = lightswitch easily).
const KEY_REMAP_STORAGE = 'emulatorKeyRemap.v1';

function loadKeyRemap() {
    try {
        const raw = localStorage.getItem(KEY_REMAP_STORAGE);
        if (!raw) return new Map();
        const obj = JSON.parse(raw);
        const m = new Map();
        for (const k of Object.keys(obj)) m.set(k, obj[k]);
        return m;
    } catch { return new Map(); }
}
function saveKeyRemap(map) {
    try {
        const obj = {};
        for (const [k, v] of map.entries()) obj[k] = v;
        localStorage.setItem(KEY_REMAP_STORAGE, JSON.stringify(obj));
    } catch { }
}

let keyRemap = loadKeyRemap();
let remapPending = null; // { from: code|null, to: code|null } while capturing

function resetKeyRemap() {
    keyRemap.clear();
    saveKeyRemap(keyRemap);
    renderRemapRows();
    updateRemapHint('Cleared all remaps.');
}

function isCaptureKey(code) { return !NON_FORWARDABLE.has(code); }

function handleRemapKeydown(e) {
    e.preventDefault();
    if (e.key === 'Escape') { remapPending = null; updateRemapHint('Cancelled.'); renderRemapRows(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!isCaptureKey(e.code)) { updateRemapHint(`"${codeLabel(e.code)}" can't be remapped.`); return; }
    if (remapPending.from === null) {
        remapPending.from = e.code;
        updateRemapHint(`Source: ${codeLabel(e.code)}. Now press a key for it to act as (Esc to cancel).`);
        renderRemapRows();
        return;
    }
    remapPending.to = e.code;
    if (remapPending.from === remapPending.to) {
        keyRemap.delete(remapPending.from);
    } else {
        keyRemap.set(remapPending.from, remapPending.to);
    }
    saveKeyRemap(keyRemap);
    remapPending = null;
    updateRemapHint('Saved.');
    renderRemapRows();
}

function codeLabel(code) {
    return code
        .replace('Key', '')
        .replace('Digit', '')
        .replace('ArrowLeft', '◀')
        .replace('ArrowRight', '▶')
        .replace('ArrowUp', '▲')
        .replace('ArrowDown', '▼')
        .replace('Space', 'SPACE')
        .replace('Enter', 'ENTER')
        .replace('Escape', 'Esc')
        .replace('ShiftLeft', 'L-Shift')
        .replace('ShiftRight', 'R-Shift')
        .replace('ControlLeft', 'L-Ctrl')
        .replace('AltLeft', 'L-Alt');
}

function updateRemapHint(text) {
    const box = document.getElementById('remapHint');
    if (box) box.textContent = text;
}

function renderRemapRows() {
    const list = document.getElementById('remapList');
    if (!list) return;
    list.innerHTML = '';
    if (keyRemap.size === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-sm text-gray-500 dark:text-gray-400';
        empty.textContent = 'No remaps yet. Click "Add remap" to create one.';
        list.appendChild(empty);
        return;
    }
    const entries = Array.from(keyRemap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [from, to] of entries) {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 justify-between bg-gray-100 dark:bg-gray-700 rounded px-3 py-2';

        const pair = document.createElement('div');
        pair.className = 'flex items-center gap-2';
        const f = document.createElement('span');
        f.className = 'font-mono text-sm font-semibold dark:text-white';
        f.textContent = codeLabel(from);
        const arrow = document.createElement('span');
        arrow.className = 'text-gray-400';
        arrow.textContent = '→';
        const t = document.createElement('span');
        t.className = 'font-mono text-sm text-indigo-600 dark:text-indigo-400 font-semibold';
        t.textContent = codeLabel(to);
        pair.append(f, arrow, t);

        const change = document.createElement('button');
        change.className = 'rounded bg-gray-500 hover:bg-gray-600 text-white text-xs px-2 py-1';
        change.textContent = 'Change';
        change.onclick = (ev) => { ev.stopPropagation(); startRemapCapture(from); };

        const del = document.createElement('button');
        del.className = 'rounded bg-red-500 hover:bg-red-600 text-white text-xs px-2 py-1';
        del.textContent = 'Remove';
        del.onclick = (ev) => {
            ev.stopPropagation();
            keyRemap.delete(from);
            saveKeyRemap(keyRemap);
            renderRemapRows();
        };

        row.append(pair, change, del);
        list.appendChild(row);
    }
}

function startRemapCapture(from) {
    remapPending = { from: from || null, to: null };
    if (from) updateRemapHint(`Press a key to act as ${codeLabel(from)} (Esc to cancel).`);
    else updateRemapHint('Press the source key you want to remap (Esc to cancel).');
    const active = document.activeElement;
    if (active && active.blur && active.tagName === 'BUTTON') active.blur();
}

function openRemapModal() {
    remapPending = null;
    renderRemapRows();
    updateRemapHint('Click "Add remap", then press the source key and the key it should act as.');
    document.getElementById('remapModal').classList.remove('hidden');
    if (heldInputKeys.size) { heldInputKeys.clear(); flushInput({ mouse: null }); }
}
function closeRemapModal() {
    remapPending = null;
    document.getElementById('remapModal').classList.add('hidden');
}

// ── On-screen mobile gamepad ────────────────────────────────────────────────
const IS_TOUCH_DEVICE = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
const MOBILE_PAD_ROWS = [
    ['KeyW', 'KeyA', 'KeyS', 'KeyD'],
    ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'],
    ['Space', 'Enter', 'ShiftRight', 'Tab', 'Escape'],
    ['KeyZ', 'KeyX', 'KeyE', 'KeyQ', 'KeyR', 'KeyC'],
];

function buildMobileGamepad() {
    const pad = document.getElementById('mobileGamepad');
    if (!pad) return;
    pad.innerHTML = '';
    for (const row of MOBILE_PAD_ROWS) {
        const rowEl = document.createElement('div');
        rowEl.className = 'flex flex-wrap justify-center gap-2 mb-2';
        for (const code of row) {
            const b = document.createElement('button');
            b.className = 'padkey flex-1 min-w-[52px] h-12 rounded-lg shadow font-mono text-sm font-semibold text-white bg-gray-700 dark:bg-gray-700 active:bg-indigo-500 select-none touch-none flex items-center justify-center';
            b.textContent = codeLabel(code);
            b.dataset.code = code;
            rowEl.appendChild(b);
        }
        pad.appendChild(rowEl);
    }
}

function padCodeDown(code) {
    unlockAudio();
    setInputKey(keyRemap.get(code) || code, true);
}
function padCodeUp(code) {
    setInputKey(keyRemap.get(code) || code, false);
}

function bindMobileGamepad() {
    const pad = document.getElementById('mobileGamepad');
    if (!pad) return;
    pad.addEventListener('pointerdown', (e) => {
        const b = e.target.closest('.padkey');
        if (!b) return;
        e.preventDefault();
        b.setPointerCapture && b.setPointerCapture(e.pointerId);
        padCodeDown(b.dataset.code);
    });
    const release = (e) => {
        const b = e.target.closest('.padkey');
        if (!b) return;
        padCodeUp(b.dataset.code);
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    pad.addEventListener('pointerleave', release);
}

let gamepadVisible = true;
function applyGamepadVisibility() {
    document.getElementById('toggleGamepadBtn').classList.toggle('hidden', !IS_TOUCH_DEVICE);
    document.getElementById('mobileGamepad').classList.toggle('hidden', !IS_TOUCH_DEVICE || !gamepadVisible);
    document.getElementById('remapBtn').classList.toggle('hidden', IS_TOUCH_DEVICE);
}

function toggleGamepad() {
    gamepadVisible = !gamepadVisible;
    applyGamepadVisibility();
}

// Global keyboard forwarding - track a held-key set so releases actually reach
// the server (a single [code] on keydown with no keyup would leave buttons
// stuck down forever and pin the game for everyone).
//
// Keys are forwarded with their raw e.code — no aliasing. WASD must reach the
// game as KeyW/KeyA/KeyS/KeyD so games bound to those keys work; the host is
// the single place that filters (--keys allowlist). A local remap can translate
// e.code → e.code first (install via the "Remap keys" modal).
const heldInputKeys = new Set();
// Keys that are pure modifiers / browser-reserved and must never reach the host.
const NON_FORWARDABLE = new Set([
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'MetaLeft', 'MetaRight', 'CapsLock', 'NumLock', 'ScrollLock',
    'F1', 'F3', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
function setInputKey(code, down) {
    const had = heldInputKeys.has(code);
    if (down) heldInputKeys.add(code); else heldInputKeys.delete(code);
    if (heldInputKeys.has(code) !== had) flushInput({ mouse: null });
}

window.addEventListener('keydown', (e) => {
    if (!currentConsoleName) return;
    if (isTypingField(e.target)) return;
    const remapModalEl = document.getElementById('remapModal');
    if (remapModalEl && !remapModalEl.classList.contains('hidden')) {
        if (remapPending) handleRemapKeydown(e);
        return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // browser/OS combos stay local
    if (e.code === 'Backquote') {
        e.preventDefault();
        if (!e.repeat) toggleCameraMode();
        return;
    }
    const code = keyRemap.get(e.code) || e.code;
    if (NON_FORWARDABLE.has(code)) return;
    e.preventDefault();
    if (!e.repeat) setInputKey(code, true);
});
window.addEventListener('keyup', (e) => {
    if (!currentConsoleName) return;
    if (isTypingField(e.target)) return;
    const remapModalEl = document.getElementById('remapModal');
    if (remapModalEl && !remapModalEl.classList.contains('hidden')) {
        return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Backquote') { e.preventDefault(); return; }
    const code = keyRemap.get(e.code) || e.code;
    if (NON_FORWARDABLE.has(code)) return;
    e.preventDefault();
    setInputKey(code, false);
});
// Releasing focus mid-press would leave a key stuck; clear everything.
window.addEventListener('blur', () => {
    if (heldInputKeys.size) { heldInputKeys.clear(); flushInput({ mouse: null }); }
});
// Keep held keys alive (the server expires keys that go quiet).
setInterval(() => { if (currentConsoleName && heldInputKeys.size > 0) flushInput({ mouse: null }); }, 800);

function isTypingField(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
}

// Unlock audio on first interaction
document.addEventListener('pointerdown', unlockAudio, { once: true });

function handleChatMessage(data) {
    // if the data has 'by' and 'message', it's a chat message
    if (data.by && data.message) {
        addChatMessage(data.by, data.message, data.time, data.pfp);
    } 
    else if (data.type === 'player_list') {
        updatePlayerList(data.players || []);
    } else if (data.type === 'player_leave') {
        removePlayerFromList(data.username);
        addSystemMessage(`${data.username} left`);
    }
}

function addChatMessage(username, message, isServer = false, isSelf = false, pfpUrl = null) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

    let messageClasses = "group flex items-center gap-3 py-1 px-3 rounded-md transition-colors ";
    
    messageClasses += "hover:bg-gray-600/10 dark:hover:bg-gray-800/60 ";

    const messageElement = document.createElement('div');
    messageElement.className = messageClasses;

    messageElement.innerHTML = `
        <div class="flex items-baseline gap-2 flex-1">
            <span class="font-bold text-[#E9E9E9] text-sm text-blue-400 hover:underline cursor-pointer">
                ${escapeHtml(username)}
            </span>
            
            <span class="text-black dark:text-white text-xs">▶</span>
            
            <span class="text-gray-900 dark:text-gray-100 text-sm flex-1 break-words whitespace-pre-wrap max-w-[70%] lg:max-w-[400px]">${escapeHtml(message)}</span>
        </div>
    `;

    chatMessages.appendChild(messageElement);
    playTouchSound()
    
    // auto-scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(message) {
    const chatMessages = document.getElementById('chatMessages')
    if (!chatMessages) return
    
    const messageEl = document.createElement('div')
    messageEl.className = 'text-xs text-gray-500 dark:text-gray-400 italic text-center py-1'
    messageEl.textContent = message
    
    chatMessages.appendChild(messageEl)
    chatMessages.scrollTop = chatMessages.scrollHeight
}

function updatePlayerList(players) {
    const playerList = document.getElementById('playerList')
    if (!playerList) return
    
    playerList.innerHTML = ''
    
    players.forEach(player => {
        const name = typeof player === 'string' ? player : (player.username || player.name || player.id || 'Player');
        addPlayerToList(name)
    })
}

function addPlayerToList(username) {
    const playerList = document.getElementById('playerList')
    if (!playerList) return
    
    // check if player already exists
    const existing = Array.from(playerList.children).find(
        el => el.dataset.username === username
    )
    if (existing) return
    
    const playerEl = document.createElement('div')
    playerEl.className = 'flex items-center gap-2 px-2 py-1.5 rounded-md bg-white dark:bg-gray-700 hover:bg-gray-600/10 dark:hover:bg-gray-800/60 '
    playerEl.dataset.username = username
    
    playerEl.innerHTML = `
        <span class="text-black dark:text-white text-xs">▶</span>
        <span class="text-sm text-gray-900 dark:text-white truncate">${escapeHtml(username)}</span>
    `
    
    playerList.appendChild(playerEl)
}

function removePlayerFromList(username) {
    const playerList = document.getElementById('playerList')
    if (!playerList) return
    
    const playerEl = Array.from(playerList.children).find(
        el => el.dataset.username === username
    )
    
    if (playerEl) {
        playerEl.remove()
    }
}

function setupChatForm() {
    const chatForm = document.getElementById('chatForm')
    const chatInput = document.getElementById('chatInput')
    
    if (!chatForm || !chatInput) return
    
    chatForm.onsubmit = (e) => {
        e.preventDefault()
        
        const message = chatInput.value.trim()
        if (!message) return
        
        if (streamWs && streamWs.readyState === WebSocket.OPEN) {
            streamWs.send(JSON.stringify({ t: 'chat', text: message }))
            
            chatInput.value = ''
        } else {
            showPrompt('Chat not connected', 'error')
        }
    }
}

function showContactModal() {
    window.open('https://discord.gg/fdjbPeHZAG')
}