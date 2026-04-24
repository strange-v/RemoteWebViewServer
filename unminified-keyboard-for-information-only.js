/**
 * ============================================================================
 * KIOSK VIRTUAL KEYBOARD - HOME ASSISTANT / CDP OPTIMIZED
 * ============================================================================
 * * HISTORY & TRIBULATIONS (Developer Notes):
 * This script evolved through a brutal gauntlet of browser edge-cases:
 * 1. CDP Timing: Script had to be lazy-loaded to survive Single Page App (SPA) body wipes.
 * 2. Shadow DOM: Home Assistant's <ha-textfield> hid inputs from standard event targets.
 * 3. Rich Text / CodeMirror: HA's YAML editor required direct DOM execCommands and focus-kicking.
 * 4. The #top-layer Bug: HA's <dialog> elements sat above standard z-index. Solved via Popover API.
 * 5. Event Swallowing: HA's top-level components called stopPropagation() on clicks. Solved via Mathematical Hit-Testing.
 * 6. Closing Ghost Clicks: Rapid touchend/click events caused through-clicks. Solved via 400ms Shield.
 * 7. Websocket Jitter: Rapid double-taps over CDP/remote connections. Solved via 250ms Debounce.
 * 8. Enter Key vs SPA Forms: Forcing native form.submit() broke SPA API authentication sequences.
 * Solved by dispatching fully simulated keydown/keypress/keyup sequences.
 * 9. Opening Ghost Clicks: Tapping low inputs caused the trailing click to instantly hit the spawned keyboard. 
 * Solved via 400ms Opening Shield to absorb residual touch events.
 * 10. Ultimate Scalability: Fixed `px` values were removed. Width/Height are now global variables,
 * and font sizes strictly scale to the Container Height using CSS `cqh` units and flexbox.
 */

(function() {
    console.log('[VKB] Script injected. Initializing...');

    // --- CONFIGURATION VARIABLES ---
    // Scalability variables. Adjust these to fit your display (e.g., 720x1280 screens).
    // The keyboard is fully responsive. Keys and font sizes will automatically 
    // recalculate based on these two variables via flexbox and CSS container queries (cqh).
    const VKB_WIDTH = '100%';    // Use a fixed width like '800px' on large horizontal displays.
    const VKB_HEIGHT = '196px';  // Total keyboard vertical height. Default reflects the old 44px * 4 rows.

    // Prevent duplicate injections if CDP evaluates this script multiple times
    if (window.__kioskKeyboardInitialized) {
        console.log('[VKB] Already initialized. Aborting duplicate injection.');
        return;
    }
    window.__kioskKeyboardInitialized = true;

    // --- State Variables ---
    let keyboardContainer = null;
    let currentLayout = 'default';
    let activeInput = null;
    let isShifted = false;

    // --- Keyboard Layouts ---
    // Includes Linux-inspired functional keys, extended symbols, and a dedicated Hide (▼) key.
    const layouts = {
        default: [
            ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
            ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
            ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
            ['▼', '?123', ',', '◀', 'Space', '▶', '.', '⏎']
        ],
        shift: [
            ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
            ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
            ['⇧', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫'],
            ['▼', '?123', ',', '◀', 'Space', '▶', '.', '⏎']
        ],
        symbols: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
            ['@', '#', '$', '%', '&', '*', '-', '+', '(', ')'],
            ['ABC', '!', '"', "'", ':', ';', '/', '?', '⌫'],
            ['▼', '=\\<', ',', '◀', 'Space', '▶', '.', '⏎']
        ],
        extended: [
            ['~', '|', '^', '_', '=', '{', '}', '[', ']','✓'],
            ['<', '>', '£', '€', '¢', '°', '±', '÷', '×', '\\'],
            ['?123', '↹', '©', '®', '™', '¿', '¡', '§', '⌫'],
            ['▼', 'ABC', ',', '◀', 'Space', '▶', '.', '⏎']
        ]
    };

    /**
     * DOM INITIALIZATION (LAZY LOADED)
     * We don't build the HTML/CSS until the very last second (when an input is clicked).
     * This protects us against SPA frameworks like Lit/React wiping the document.body on initial load.
     */
    function ensureDOM() {
        if (!document.body || !document.head) {
            console.warn('[VKB] document.body or head not ready.');
            return false;
        }

        // 1. Inject CSS Overrides
        if (!document.getElementById('kiosk-vkb-style')) {
            console.log('[VKB] Injecting CSS overrides.');
            const style = document.createElement('style');
            style.id = 'kiosk-vkb-style';
            
            // NOTE ON !IMPORTANT: Home Assistant uses aggressive global resets.
            // NOTE ON POPOVER: We use display: flex hooked to :popover-open to utilize the #top-layer API.
            // NOTE ON SCALING: Container uses 'container-type: size' so fonts dynamically track VKB_HEIGHT.
            style.textContent = `
                #kiosk-vkb-container {
                    position: fixed !important;
                    top: auto !important;
                    bottom: -200vh !important; /* Forces off screen entirely regardless of height */
                    left: 0 !important;
                    right: 0 !important;
                    margin: 0 auto !important; /* Centers horizontally if width < 100% */
                    width: ${VKB_WIDTH} !important;
                    height: ${VKB_HEIGHT} !important;
                    container-type: size; /* Enables CQH font scaling */
                    background: #1e1e1e;
                    border-top: 2px solid #333;
                    z-index: 2147483647;
                    display: flex;
                    flex-direction: column;
                    padding: 4px;
                    box-sizing: border-box;
                    user-select: none;
                    -webkit-user-select: none;
                    font-family: 'DejaVu Sans', 'Liberation Sans', Ubuntu, Roboto, sans-serif;
                    touch-action: manipulation;
                    border: none;
                }
                #kiosk-vkb-container:popover-open {
                    display: flex;
                }
                #kiosk-vkb-container.vkb-visible {
                    bottom: 0 !important;
                }
                .vkb-row {
                    display: flex;
                    justify-content: center;
                    margin-bottom: 4px;
                    width: 100%;
                    gap: 4px;
                    flex: 1; /* Automatically stretches height evenly */
                }
                .vkb-row:last-child {
                    margin-bottom: 0;
                }
                .vkb-key {
                    flex: 1; /* Automatically stretches width evenly */
                    background: #383838;
                    color: #f8f8f2;
                    border: 1px solid #2a2a2a;
                    border-radius: 2px;
                    font-size: 11.5cqh; /* Scales precisely to parent container height */
                    font-weight: normal;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                }
                .vkb-key:active { background: #555555; }
                .vkb-key-layout { background: #324a5f; color: #e2e8f0; font-size: 9cqh; }
                .vkb-key-layout:active { background: #233544; }
                .vkb-key-special { background: #485c4a; color: #e2e8f0; font-size: 11cqh; }
                .vkb-key-special:active { background: #364538; }
                .vkb-key-large-icon { font-size: 15cqh; }
                .vkb-key-backspace { font-size: 18cqh; }
                .vkb-key-hide { background: #8b3a3a; color: #e2e8f0; font-size: 12.5cqh; }
                .vkb-key-hide:active { background: #6b2a2a; }
                .vkb-key-enter { background: #E95420; color: #ffffff; border-color: #c94618; font-size: 12.5cqh; }
                .vkb-key-enter:active { background: #c94618; }
                .vkb-key-space { flex: 3; }
                .vkb-key-arrow { flex: 0.8; }
            `;
            document.head.appendChild(style);
        }

        // 2. Inject HTML Container (Using Popover API)
        if (!keyboardContainer) {
            console.log('[VKB] Creating keyboard DOM elements.');
            keyboardContainer = document.createElement('div');
            keyboardContainer.id = 'kiosk-vkb-container';
            // Enable the Popover API to break out of all z-index stacking contexts
            if (keyboardContainer.popover !== undefined) {
                keyboardContainer.popover = 'manual';
            }
            renderKeyboard();
        }

        // 3. Framework Resistance: Re-attach if HA destroyed it
        if (!document.body.contains(keyboardContainer)) {
            console.log('[VKB] Appending keyboard to body.');
            document.body.appendChild(keyboardContainer);
        }

        return true;
    }

    /**
     * KEYBOARD RENDERER
     * Dynamically builds the DOM nodes based on the current layout state.
     */
    function renderKeyboard() {
        if (!keyboardContainer) return;
        keyboardContainer.innerHTML = '';
        const layout = layouts[currentLayout];

        layout.forEach(row => {
            const rowDiv = document.createElement('div');
            rowDiv.className = 'vkb-row';

            row.forEach(key => {
                const keyBtn = document.createElement('button');
                keyBtn.className = 'vkb-key';
                keyBtn.textContent = key === 'Space' ? '' : key;
                keyBtn.dataset.key = key;

                // Apply semantic CSS classes
                if (['?123', 'ABC', '=\\<'].includes(key)) keyBtn.classList.add('vkb-key-layout');
                if (['⇧', '⌫', '◀', '▶', '↹'].includes(key)) keyBtn.classList.add('vkb-key-special');
                if (['⇧', '↹'].includes(key)) keyBtn.classList.add('vkb-key-large-icon');
                if (key === '⌫') keyBtn.classList.add('vkb-key-backspace');
                if (key === '▼') keyBtn.classList.add('vkb-key-hide');
                if (key === 'Space') keyBtn.classList.add('vkb-key-space');
                if (key === '◀' || key === '▶') keyBtn.classList.add('vkb-key-arrow');
                if (key === '⏎') keyBtn.classList.add('vkb-key-enter');

                // Shift State Highlight
                if (key === '⇧' && isShifted) {
                    keyBtn.style.background = '#e2e8f0';
                    keyBtn.style.color = '#121212';
                }

                // NOTE: We DO NOT attach mousedown/touchstart listeners here anymore.
                // The Master Event Shield handles interaction globally to prevent HA from swallowing clicks.
                rowDiv.appendChild(keyBtn);
            });
            keyboardContainer.appendChild(rowDiv);
        });
    }

    /**
     * CORE LOGIC: PROCESS KEYPRESS
     * Handles typing, cursor manipulation, and CodeMirror (Rich Text) integrations.
     */
    function processKey(key) {
        if (!activeInput) {
            console.warn('[VKB] Key pressed but activeInput is null.');
            return;
        }
        console.log('[VKB] Processing key:', key);

        // KICKSTAND: Wake up CodeMirror or dormant HA inputs before typing
        if (typeof activeInput.focus === 'function') {
            activeInput.focus();
        }

        // Helper to insert text at the exact cursor position
        const insertText = (text) => {
            if (activeInput.isContentEditable) {
                // The only reliable way to inject into CodeMirror/Rich text
                document.execCommand('insertText', false, text);
            } else {
                // Standard input string slicing
                let val = activeInput.value || '';
                let start = activeInput.selectionStart || 0;
                let end = activeInput.selectionEnd || 0;
                activeInput.value = val.substring(0, start) + text + val.substring(end);
                activeInput.selectionStart = activeInput.selectionEnd = start + text.length;
            }
        };

        switch (key) {
            case '▼':
                hideKeyboard();
                break;
            case '⇧':
                isShifted = !isShifted;
                currentLayout = isShifted ? 'shift' : 'default';
                renderKeyboard();
                break;
            case '?123':
                currentLayout = 'symbols';
                isShifted = false;
                renderKeyboard();
                break;
            case 'ABC':
                currentLayout = 'default';
                isShifted = false;
                renderKeyboard();
                break;
            case '=\\<':
                currentLayout = 'extended';
                isShifted = false;
                renderKeyboard();
                break;
            case '↹':
                insertText('\t');
                break;
            case '⌫':
                if (activeInput.isContentEditable) {
                    document.execCommand('delete', false, null);
                } else {
                    let val = activeInput.value || '';
                    let start = activeInput.selectionStart || 0;
                    let end = activeInput.selectionEnd || 0;
                    if (start === end && start > 0) {
                        activeInput.value = val.substring(0, start - 1) + val.substring(end);
                        activeInput.selectionStart = activeInput.selectionEnd = start - 1;
                    } else if (start !== end) {
                        activeInput.value = val.substring(0, start) + val.substring(end);
                        activeInput.selectionStart = activeInput.selectionEnd = start;
                    }
                }
                break;
            case 'Space':
                insertText(' ');
                break;
            case '◀':
                if (!activeInput.isContentEditable) {
                    let start = activeInput.selectionStart || 0;
                    if (start > 0) activeInput.selectionStart = activeInput.selectionEnd = start - 1;
                }
                break;
            case '▶':
                if (!activeInput.isContentEditable) {
                    let end = activeInput.selectionEnd || 0;
                    let valLen = (activeInput.value || '').length;
                    if (end < valLen) activeInput.selectionStart = activeInput.selectionEnd = end + 1;
                }
                break;
            case '⏎':
                if (activeInput.isContentEditable) {
                    document.execCommand('insertParagraph', false, null);
                    activeInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                } else if (activeInput.tagName === 'TEXTAREA') {
                    insertText('\n');
                    activeInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                    activeInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                } else {
                    // MODERN SPA SUBMISSION HOOK
                    // Do NOT use activeInput.form.submit(). It triggers a native HTTP POST that bypasses 
                    // Javascript-based authentication validation (like HA Login sequences).
                    // Instead, simulate a physical Enter keystroke. Lit/React look for exactly this.
                    const evInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true };
                    activeInput.dispatchEvent(new KeyboardEvent('keydown', evInit));
                    activeInput.dispatchEvent(new KeyboardEvent('keypress', evInit));
                    activeInput.dispatchEvent(new KeyboardEvent('keyup', evInit));
                    hideKeyboard();
                }
                break;
            default:
                if (key) {
                    insertText(key);
                    if (isShifted) {
                        isShifted = false;
                        currentLayout = 'default';
                        renderKeyboard();
                    }
                }
                break;
        }

        // Framework hydration (Tell Lit/React that the state has changed)
        // Note: composed: true allows the event to escape the Shadow DOM
        if (key !== '⏎' && key !== '▼') {
            activeInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            activeInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
    }

    /**
     * VISIBILITY CONTROLS
     */
    function showKeyboard(inputElement) {
        console.log('[VKB] showKeyboard triggered for:', inputElement);
        activeInput = inputElement;
        renderKeyboard();

        // OPENING SHIELD: Prevent trailing events from the initial tap from hitting a key
        window.__vkbOpeningShield = Date.now();

        // THE Z-BUMP: If already open, close and reopen to force the browser to restack
        // it above any newly opened Home Assistant <dialog> elements in the #top-layer.
        if (keyboardContainer.showPopover) {
            if (keyboardContainer.matches(':popover-open')) {
                keyboardContainer.hidePopover();
            }
            keyboardContainer.showPopover();
        }

        keyboardContainer.classList.add('vkb-visible');

        // Instant scroll jump (no smooth animation for performance)
        if (activeInput && activeInput.scrollIntoView) {
            activeInput.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
    }

    function hideKeyboard() {
        console.log('[VKB] hideKeyboard triggered. Activating ghost-click shield.');
        
        // CLOSING GHOST-CLICK SHIELD TRIGGER
        // Touch screens send a delayed "click" event after pointerdown. We set a 400ms 
        // deadzone to prevent that click from falling through to HA elements beneath us.
        window.__vkbClosingShield = Date.now();

        if (keyboardContainer) {
            keyboardContainer.classList.remove('vkb-visible');
            if (keyboardContainer.hidePopover && keyboardContainer.matches(':popover-open')) {
                keyboardContainer.hidePopover();
            }
        }
        
        if (activeInput && activeInput.blur) {
            activeInput.blur();
        }
        activeInput = null;
        isShifted = false;
        currentLayout = 'default';
    }

    /**
     * SHADOW ROOT PIERCER
     * Iterates through the raw click path (bypassing HA's event retargeting).
     * Automatically hunts inside specific Web Components to find the hidden inner inputs.
     */
    const validTypes = ['text', 'email', 'number', 'password', 'search', 'tel', 'url'];
    
    function resolveInputFromPath(path) {
        for (let i = 0; i < path.length; i++) {
            let el = path[i];
            if (!el || !el.tagName) continue;
            
            let t = el.tagName.toUpperCase();
            
            // Standard Inputs
            if (t === 'INPUT' && validTypes.includes(el.type)) return el;
            if (t === 'TEXTAREA' || el.isContentEditable || (el.classList && el.classList.contains('cm-content'))) return el;
            
            // Home Assistant Specific Wrappers
            if (t === 'HA-TEXTFIELD' || t === 'HA-SEARCH-INPUT' || t === 'HA-CODE-EDITOR' || t === 'HA-SELECTOR-TEXT') {
                let inner = el.shadowRoot ? el.shadowRoot.querySelector('input, textarea, [contenteditable="true"], .cm-content') : null;
                if (inner) return inner;
            }
        }
        return null; // Clicked on something that doesn't accept text
    }

    /**
     * GENERAL FOCUS HANDLER
     */
    function checkAndShowKeyboard(e) {
        // e.composedPath() is mandatory for Shadow DOM
        const path = e.composedPath ? e.composedPath() : [e.target];
        const targetInput = resolveInputFromPath(path);
        
        if (targetInput) {
            console.log('[VKB] Valid DOM element found via', e.type, ':', targetInput);
            if (ensureDOM()) {
                const isVisible = keyboardContainer && keyboardContainer.classList.contains('vkb-visible');
                // If it's a new input, or the same input but the keyboard is currently hidden, show it!
                if (activeInput !== targetInput || !isVisible) {
                    showKeyboard(targetInput);
                } else {
                    console.log('[VKB] Element already active and visible. Ignoring.');
                }
            }
        } else {
            if (e.type === 'focusin') console.log('[VKB] focusin ignored: Target is not a valid input.');
        }
    }

    // Attach base focus/click listeners to the document
    document.addEventListener('focusin', checkAndShowKeyboard, true);
    document.addEventListener('click', checkAndShowKeyboard, true);

    /**
     * THE MASTER EVENT SHIELD
     * The most critical piece of the architecture. We listen to ALL interaction events
     * at the top 'useCapture: true' phase to intercept them before Home Assistant can.
     */
    const interactionEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'];
    
    interactionEvents.forEach(ev => {
        document.addEventListener(ev, function(e) {
            
            // 1. Closing Ghost-Click Shield (Active for 400ms after closing)
            if (window.__vkbClosingShield && (Date.now() - window.__vkbClosingShield < 400)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                return;
            }

            if (keyboardContainer && keyboardContainer.classList.contains('vkb-visible')) {
                
                // Extract physical touch coordinates (X/Y)
                let x = e.clientX;
                let y = e.clientY;
                if (x === undefined && e.changedTouches && e.changedTouches.length > 0) {
                    x = e.changedTouches[0].clientX;
                    y = e.changedTouches[0].clientY;
                }
                if (x === undefined || y === undefined) return;

                // 2. The Mathematical Bounds Check
                // Bypasses DOM-based hit testing entirely. If you touched the screen
                // inside the keyboard's geographic territory, we intercept it.
                const rect = keyboardContainer.getBoundingClientRect();
                if (y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right) {
                    
                    // MURDER THE EVENT: Do not let HA know a click happened.
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();

                    // 3. Opening Ghost-Click Shield (Active for 400ms after spawning)
                    if (window.__vkbOpeningShield && (Date.now() - window.__vkbOpeningShield < 400)) {
                        return;
                    }

                    // Only process keypress logic on the initial down-touch
                    if (['pointerdown', 'touchstart', 'mousedown', 'click'].includes(ev)) {
                        
                        // 4. The Websocket Jitter Debounce
                        // Prevent rapid double-clicks from misfiring the same key.
                        if (window.__vkbLastTap && (Date.now() - window.__vkbLastTap < 250)) return;
                        window.__vkbLastTap = Date.now();

                        // Mathematically determine which specific key was pressed
                        const keys = keyboardContainer.querySelectorAll('.vkb-key');
                        let foundKey = null;
                        for (let i = 0; i < keys.length; i++) {
                            const kRect = keys[i].getBoundingClientRect();
                            if (y >= kRect.top && y <= kRect.bottom && x >= kRect.left && x <= kRect.right) {
                                foundKey = keys[i];
                                break;
                            }
                        }

                        if (foundKey) {
                            const key = foundKey.dataset.key;
                            
                            // Visual Feedback (Clean style reset to fix sticking bugs)
                            foundKey.style.background = '#555';
                            setTimeout(() => {
                                foundKey.style.background = ''; // Wipe inline style to revert to CSS class default
                            }, 100);
                            
                            processKey(key);
                        }
                    }
                    return; // Exit out of the interaction listener
                }

                // 5. Outside Click Detection (Hide trigger)
                // If we reach here, the user tapped OUTSIDE the geographic bounds of the keyboard.
                if (ev === 'pointerdown') {
                    const path = e.composedPath ? e.composedPath() : [e.target];
                    const clickedOnInput = resolveInputFromPath(path) !== null;
                    
                    if (!clickedOnInput) {
                        console.log('[VKB] Pointer down outside. Hiding.');
                        hideKeyboard();
                    } else {
                        console.log('[VKB] Pointer down on input. Staying open.');
                    }
                }
            }
        }, true); // useCapture: true is REQUIRED to beat the SPA event delegation
    });

    console.log('[VKB] Initialization complete (Fully Scalable, Ghost-Click Shield Active).');

})();
