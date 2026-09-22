// ==UserScript==
// @name         AutoReadingForLD
// @name:zh-CN   AutoReadingForLD - LINUX DO 沉浸阅读助手
// @namespace    https://github.com/LaminaLumen/AutoReadingForLD
// @version      2.0.0
// @description  为 LINUX DO 长帖提供自然节奏滚动、三种阅读模式、懒加载等待与沉浸式控制面板。
// @author       pboy, LaminaLumen contributors
// @license      MIT
// @match        https://linux.do/t/*
// @match        https://linux.do/n/*
// @match        https://linux.do/new*
// @match        https://linux.do/unread*
// @match        https://linux.do/unseen*
// @match        https://linux.do/latest*
// @icon         https://linux.do/favicon.ico
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/LaminaLumen/AutoReadingForLD/main/AutoReadingForLD.user.js
// @updateURL    https://raw.githubusercontent.com/LaminaLumen/AutoReadingForLD/main/AutoReadingForLD.user.js
// @homepageURL  https://github.com/LaminaLumen/AutoReadingForLD
// @supportURL   https://github.com/LaminaLumen/AutoReadingForLD/issues
// ==/UserScript==

(function () {
    'use strict';

    const APP = Object.freeze({
        name: 'AutoReadingForLD',
        version: '2.0.0',
        rootId: 'auto-reading-for-ld-root',
        storageKey: 'auto-reading-for-ld:settings:v2',
        queueStorageKey: 'auto-reading-for-ld:queue:v1',
        legacyStorageKey: 'linuxdo-autoscroll-settings'
    });

    const CONFIG = Object.freeze({
        defaultSpeed: 52,
        minSpeed: 12,
        maxSpeed: 160,
        speedStep: 4,
        speedVariationMin: 0.88,
        speedVariationMax: 1.12,
        speedVariationIntervalMinMs: 2800,
        speedVariationIntervalMaxMs: 6200,
        bottomThreshold: 120,
        bottomWaitMs: 6000,
        queueCooldownMs: 8000,
        queueMinItems: 1,
        queueMaxItems: 20,
        queueDefaultItems: 8,
        queueMaxAgeMs: 6 * 60 * 60 * 1000,
        uiRefreshMs: 120,
        edgePadding: 12,
        snapThreshold: 24
    });

    const SPEED_PRESETS = Object.freeze([
        { key: 'focus', label: '沉浸', speed: 28 },
        { key: 'steady', label: '标准', speed: 52 },
        { key: 'skim', label: '速览', speed: 96 }
    ]);

    const READING_MODES = Object.freeze([
        { key: 'single', label: '当前帖', detail: '手动开始，读到底后停止', icon: 'article' },
        { key: 'auto', label: '自动帖', detail: '手动打开帖子后自动开始', icon: 'playCircle' },
        { key: 'queue', label: '连续读', detail: '从列表建立有上限的阅读队列', icon: 'bookOpenText' }
    ]);

    const STATE_COPY = Object.freeze({
        idle: { chip: '待机', title: '准备就绪', detail: '按 Alt + S 开始阅读' },
        running: { chip: '阅读中', title: '正在平稳下行', detail: '再次点击即可暂停' },
        loading: { chip: '载入', title: '发现后续内容', detail: '正在衔接新楼层' },
        waiting: { chip: '等待', title: '等待后续楼层', detail: '确认是否已到帖子底部' },
        queue: { chip: '队列', title: '连续阅读已就绪', detail: '将在当前标签页逐篇阅读' },
        cooldown: { chip: '冷却', title: '本帖阅读完成', detail: '稍后进入下一篇' },
        paused: { chip: '暂停', title: '阅读已暂停', detail: '保留当前位置和本次统计' },
        done: { chip: '完成', title: '已经读到末尾', detail: '可返回顶部后再次开始' }
    });

    if (document.getElementById(APP.rootId)) {
        return;
    }

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

    function isTopicRoute() {
        return /^\/(?:t|n)\//.test(window.location.pathname);
    }

    function isListRoute() {
        return /^\/(?:new|unread|unseen|latest)(?:\/|$)/.test(window.location.pathname);
    }

    function isSupportedRoute() {
        return isTopicRoute() || isListRoute();
    }

    function isEditableTarget(target) {
        if (!(target instanceof Element)) {
            return false;
        }

        return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .d-editor-input'));
    }

    function formatTime(milliseconds) {
        const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function formatScreens(distance) {
        const viewport = Math.max(window.innerHeight, 1);
        const screens = distance / viewport;
        return screens < 10 ? `${screens.toFixed(1)} 屏` : `${Math.round(screens)} 屏`;
    }

    function getScrollMetrics() {
        const scrollingElement = document.scrollingElement || document.documentElement;
        const height = Math.max(
            scrollingElement.scrollHeight,
            document.documentElement.scrollHeight,
            document.body?.scrollHeight || 0
        );
        const viewport = window.innerHeight || document.documentElement.clientHeight || 1;
        const top = window.scrollY || scrollingElement.scrollTop || 0;
        const maximum = Math.max(0, height - viewport);

        return {
            element: scrollingElement,
            height,
            viewport,
            top,
            maximum,
            remaining: Math.max(0, maximum - top),
            progress: maximum > 0 ? clamp((top / maximum) * 100, 0, 100) : 100
        };
    }

    const StorageManager = {
        defaults() {
            return {
                speed: CONFIG.defaultSpeed,
                mode: 'single',
                queueLimit: CONFIG.queueDefaultItems,
                minimized: true,
                autoPauseOnHidden: true,
                pauseOnManualInput: true,
                position: null
            };
        },

        normalize(value) {
            const defaults = this.defaults();
            const rawPosition = value?.position;
            const position = rawPosition
                && isFiniteNumber(rawPosition.left)
                && isFiniteNumber(rawPosition.top)
                ? { left: rawPosition.left, top: rawPosition.top }
                : null;

            return {
                speed: clamp(
                    isFiniteNumber(value?.speed) ? value.speed : defaults.speed,
                    CONFIG.minSpeed,
                    CONFIG.maxSpeed
                ),
                mode: READING_MODES.some((mode) => mode.key === value?.mode) ? value.mode : defaults.mode,
                queueLimit: clamp(
                    Number.isFinite(Number(value?.queueLimit)) ? Math.round(Number(value.queueLimit)) : defaults.queueLimit,
                    CONFIG.queueMinItems,
                    CONFIG.queueMaxItems
                ),
                minimized: typeof value?.minimized === 'boolean' ? value.minimized : defaults.minimized,
                autoPauseOnHidden: typeof value?.autoPauseOnHidden === 'boolean'
                    ? value.autoPauseOnHidden
                    : defaults.autoPauseOnHidden,
                pauseOnManualInput: typeof value?.pauseOnManualInput === 'boolean'
                    ? value.pauseOnManualInput
                    : defaults.pauseOnManualInput,
                position
            };
        },

        migrateLegacy() {
            try {
                const legacyText = localStorage.getItem(APP.legacyStorageKey);
                if (!legacyText) {
                    return null;
                }

                const legacy = JSON.parse(legacyText);
                const legacySpeed = Number(legacy.speed);

                return this.normalize({
                    // 旧版本按 px/frame 计速；迁移时换算为更温和的 px/s。
                    speed: Number.isFinite(legacySpeed) ? legacySpeed * 12 : CONFIG.defaultSpeed,
                    minimized: typeof legacy.isMinimized === 'boolean' ? legacy.isMinimized : true
                });
            } catch (error) {
                console.warn(`[${APP.name}] 旧配置迁移失败，将使用默认设置。`, error);
                return null;
            }
        },

        load() {
            try {
                const savedText = localStorage.getItem(APP.storageKey);
                if (savedText) {
                    return this.normalize(JSON.parse(savedText));
                }

                const migrated = this.migrateLegacy();
                if (migrated) {
                    this.save(migrated);
                    return migrated;
                }
            } catch (error) {
                console.warn(`[${APP.name}] 设置读取失败，将使用默认设置。`, error);
            }

            return this.defaults();
        },

        save(settings) {
            try {
                localStorage.setItem(APP.storageKey, JSON.stringify(this.normalize(settings)));
            } catch (error) {
                console.warn(`[${APP.name}] 设置保存失败。`, error);
            }
        }
    };

    const settings = StorageManager.load();

    // 图标路径来自 Phosphor Icons 2.1.1 Regular（MIT），内嵌后无需联网加载字体或图标资源。
    const PHOSPHOR_ICONS = Object.freeze({
        dotsSixVertical: '<path d="M104,60A12,12,0,1,1,92,48,12,12,0,0,1,104,60Zm60,12a12,12,0,1,0-12-12A12,12,0,0,0,164,72ZM92,116a12,12,0,1,0,12,12A12,12,0,0,0,92,116Zm72,0a12,12,0,1,0,12,12A12,12,0,0,0,164,116ZM92,184a12,12,0,1,0,12,12A12,12,0,0,0,92,184Zm72,0a12,12,0,1,0,12,12A12,12,0,0,0,164,184Z"/>',
        article: '<path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,160H40V56H216V200ZM184,96a8,8,0,0,1-8,8H80a8,8,0,0,1,0-16h96A8,8,0,0,1,184,96Zm0,32a8,8,0,0,1-8,8H80a8,8,0,0,1,0-16h96A8,8,0,0,1,184,128Zm0,32a8,8,0,0,1-8,8H80a8,8,0,0,1,0-16h96A8,8,0,0,1,184,160Z"/>',
        playCircle: '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm48.24-94.78-64-40A8,8,0,0,0,100,88v80a8,8,0,0,0,12.24,6.78l64-40a8,8,0,0,0,0-13.56ZM116,153.57V102.43L156.91,128Z"/>',
        bookOpenText: '<path d="M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64ZM160,88h40a8,8,0,0,1,0,16H160a8,8,0,0,1,0-16Zm48,40a8,8,0,0,1-8,8H160a8,8,0,0,1,0-16h40A8,8,0,0,1,208,128Zm0,32a8,8,0,0,1-8,8H160a8,8,0,0,1,0-16h40A8,8,0,0,1,208,160Z"/>',
        minus: '<path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"/>',
        play: '<path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z"/>',
        pause: '<path d="M200,32H160a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Zm0,176H160V48h40ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Zm0,176H56V48H96Z"/>',
        stop: '<path d="M200,40H56A16,16,0,0,0,40,56V200a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,160H56V56H200V200Z"/>',
        speedometer: '<path d="M114.34,154.34l96-96a8,8,0,0,1,11.32,11.32l-96,96a8,8,0,0,1-11.32-11.32ZM128,88a63.9,63.9,0,0,1,20.44,3.33,8,8,0,1,0,5.11-15.16A80,80,0,0,0,48.49,160.88,8,8,0,0,0,56.43,168c.29,0,.59,0,.89-.05a8,8,0,0,0,7.07-8.83A64.92,64.92,0,0,1,64,152,64.07,64.07,0,0,1,128,88Zm99.74,13a8,8,0,0,0-14.24,7.3,96.27,96.27,0,0,1,5,75.71l-181.1-.07A96.24,96.24,0,0,1,128,56h.88a95,95,0,0,1,42.82,10.5A8,8,0,1,0,179,52.27a112,112,0,0,0-156.66,137A16.07,16.07,0,0,0,37.46,200H218.53a16,16,0,0,0,15.11-10.71,112.35,112.35,0,0,0-5.9-88.3Z"/>',
        slidersHorizontal: '<path d="M40,88H73a32,32,0,0,0,62,0h81a8,8,0,0,0,0-16H135a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16Zm64-24A16,16,0,1,1,88,80,16,16,0,0,1,104,64ZM216,168H199a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16h97a32,32,0,0,0,62,0h17a8,8,0,0,0,0-16Zm-48,24a16,16,0,1,1,16-16A16,16,0,0,1,168,192Z"/>',
        chartLineUp: '<path d="M232,208a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V48a8,8,0,0,1,16,0V156.69l50.34-50.35a8,8,0,0,1,11.32,0L128,132.69,180.69,80H160a8,8,0,0,1,0-16h40a8,8,0,0,1,8,8v40a8,8,0,0,1-16,0V91.31l-58.34,58.35a8,8,0,0,1-11.32,0L96,123.31l-56,56V200H224A8,8,0,0,1,232,208Z"/>',
        shieldCheck: '<path d="M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.26,47,25.53a8,8,0,0,0,4.2,0c1-.27,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0ZM82.34,141.66a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32l-56,56a8,8,0,0,1-11.32,0Z"/>',
        caretDown: '<path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/>',
        waveSine: '<path d="M239.24,131.4c-22,46.8-41.4,68.6-61.2,68.6-25.1,0-40.73-33.32-57.28-68.6C107.7,103.56,92.9,72,78,72c-16.4,0-36.31,37.21-46.72,59.4a8,8,0,0,1-14.48-6.8C38.71,77.8,58.16,56,78,56c25.1,0,40.73,33.32,57.28,68.6C148.3,152.44,163.1,184,178,184c16.4,0,36.31-37.21,46.72-59.4a8,8,0,0,1,14.48,6.8Z"/>',
        arrowCounterClockwise: '<path d="M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z"/>'
    });

    function renderIcon(name, className = 'icon', attributes = '') {
        const extraAttributes = attributes ? ` ${attributes}` : '';
        return `<svg class="${className}"${extraAttributes} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${PHOSPHOR_ICONS[name]}</svg>`;
    }

    const host = document.createElement('div');
    host.id = APP.rootId;
    host.dataset.theme = 'light';
    host.hidden = !isSupportedRoute();
    host.style.position = 'fixed';
    host.style.top = '96px';
    host.style.right = '20px';
    host.style.zIndex = '2147483000';
    host.style.width = 'max-content';
    host.style.height = 'max-content';
    host.style.margin = '0';
    host.style.padding = '0';
    host.style.border = '0';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
        <style>
            :host {
                --surface: #f7f4ec;
                --surface-raised: #fffdf8;
                --rail: #f0eee6;
                --rail-selected: #e7ebe4;
                --ink: #263029;
                --muted: #6d756f;
                --faint: #969d97;
                --line: #dcddd5;
                --line-strong: #c9cdc4;
                --forest: #315f4e;
                --forest-deep: #24493d;
                --forest-soft: #e4ebe6;
                --action: #315f4e;
                --action-hover: #24493d;
                --terracotta: #b96849;
                --terracotta-soft: #f3e7df;
                --danger: #94513f;
                --shadow: 0 18px 44px rgba(33, 43, 36, 0.16), 0 3px 10px rgba(33, 43, 36, 0.08);
                color: var(--ink);
                color-scheme: light;
                font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                font-size: 14px;
                line-height: 1.45;
                -webkit-font-smoothing: antialiased;
                text-rendering: optimizeLegibility;
            }

            :host([data-theme="dark"]) {
                --surface: #1d221e;
                --surface-raised: #242a25;
                --rail: #191e1a;
                --rail-selected: #29332c;
                --ink: #ece8de;
                --muted: #aab2ab;
                --faint: #7c867e;
                --line: #343c36;
                --line-strong: #465048;
                --forest: #78a18e;
                --forest-deep: #8db39f;
                --forest-soft: #2b3b32;
                --action: #3f6f5c;
                --action-hover: #4a806a;
                --terracotta: #ce8262;
                --terracotta-soft: #3d2e27;
                --danger: #e0a08a;
                --shadow: 0 22px 52px rgba(0, 0, 0, 0.42), 0 3px 12px rgba(0, 0, 0, 0.28);
                color-scheme: dark;
            }

            *, *::before, *::after {
                box-sizing: border-box;
            }

            button,
            input,
            summary {
                font: inherit;
            }

            button {
                color: inherit;
            }

            [hidden] {
                display: none !important;
            }

            .icon {
                display: block;
                width: 1em;
                height: 1em;
                flex: 0 0 auto;
            }

            button:focus-visible,
            input:focus-visible,
            summary:focus-visible {
                outline: 2px solid var(--terracotta);
                outline-offset: 2px;
            }

            .shell {
                --speed-progress: 0%;
                width: 336px;
                user-select: none;
            }

            .panel {
                display: grid;
                grid-template-columns: 70px minmax(0, 1fr);
                width: 336px;
                max-height: min(536px, calc(100vh - 24px));
                overflow: hidden;
                border: 1px solid var(--line-strong);
                border-radius: 14px;
                background: var(--surface-raised);
                box-shadow: var(--shadow);
                transform-origin: var(--panel-origin-x, 100%) var(--panel-origin-y, 0%);
                animation: panel-in 180ms ease-out both;
            }

            .mode-rail {
                display: flex;
                min-height: 412px;
                flex-direction: column;
                border-right: 1px solid var(--line);
                background: var(--rail);
            }

            .drag-strip {
                display: grid;
                min-height: 56px;
                place-items: center;
                border-bottom: 1px solid var(--line);
                color: var(--faint);
                cursor: grab;
                touch-action: none;
            }

            .drag-strip:active,
            .panel__header:active {
                cursor: grabbing;
            }

            .drag-strip .icon {
                font-size: 17px;
            }

            .mode-nav {
                display: grid;
            }

            .mode-button {
                position: relative;
                display: grid;
                min-height: 76px;
                place-content: center;
                gap: 6px;
                padding: 10px 4px;
                border: 0;
                border-bottom: 1px solid var(--line);
                background: transparent;
                color: var(--muted);
                text-align: center;
                cursor: pointer;
                transition: color 140ms ease, background 140ms ease;
            }

            .mode-button::before {
                position: absolute;
                top: 16px;
                bottom: 16px;
                left: 0;
                width: 3px;
                border-radius: 0 3px 3px 0;
                background: transparent;
                content: "";
            }

            .mode-button:hover {
                background: var(--surface);
                color: var(--ink);
            }

            .mode-button[aria-pressed="true"] {
                background: var(--rail-selected);
                color: var(--forest-deep);
            }

            .mode-button[aria-pressed="true"]::before {
                background: var(--terracotta);
            }

            .mode-icon {
                margin: 0 auto;
                color: var(--faint);
                font-size: 19px;
                transition: color 140ms ease, transform 140ms ease;
            }

            .mode-button:hover .mode-icon {
                color: var(--forest);
            }

            .mode-button[aria-pressed="true"] .mode-icon {
                color: var(--terracotta);
                transform: translateY(-1px);
            }

            .mode-button strong {
                font-size: 13px;
                font-weight: 680;
                line-height: 1.2;
            }

            .rail-shortcut {
                display: grid;
                margin-top: auto;
                min-height: 44px;
                place-items: center;
                border-top: 1px solid var(--line);
                color: var(--faint);
            }

            .rail-shortcut kbd {
                padding: 3px 5px;
                border: 1px solid var(--line-strong);
                border-radius: 4px;
                background: var(--surface-raised);
                font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
                font-size: 9px;
                font-weight: 650;
                box-shadow: 0 1px 0 var(--line);
            }

            .panel__main {
                display: flex;
                min-width: 0;
                max-height: min(536px, calc(100vh - 24px));
                flex-direction: column;
                background: var(--surface-raised);
            }

            .panel__header {
                display: flex;
                min-height: 56px;
                flex: 0 0 auto;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 9px 11px 8px 15px;
                border-bottom: 1px solid var(--line);
                cursor: grab;
                touch-action: none;
            }

            .brand {
                display: grid;
                min-width: 0;
                gap: 1px;
            }

            .brand__name {
                overflow: hidden;
                color: var(--ink);
                font-family: "Songti SC", STSong, "Noto Serif SC", "Source Han Serif SC", serif;
                font-size: 17px;
                font-weight: 700;
                line-height: 1.2;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .brand__meta {
                color: var(--faint);
                font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
                font-size: 9px;
                font-weight: 650;
                letter-spacing: 0.08em;
            }

            .minimize-button {
                display: grid;
                width: 32px;
                height: 32px;
                min-width: 32px;
                place-items: center;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 8px;
                background: transparent;
                color: var(--muted);
                font-size: 16px;
                cursor: pointer;
            }

            .minimize-button:hover {
                background: var(--surface);
                border-color: var(--line);
                color: var(--ink);
            }

            .panel__body {
                min-height: 0;
                flex: 1 1 auto;
                overflow-x: hidden;
                overflow-y: auto;
                padding: 14px 15px 10px;
                scrollbar-color: var(--line-strong) transparent;
                scrollbar-width: thin;
            }

            .hero {
                display: grid;
                gap: 6px;
            }

            .state-line {
                display: flex;
                align-items: center;
                gap: 7px;
                color: var(--forest-deep);
                font-size: 12px;
                font-weight: 700;
            }

            .state-dot {
                width: 7px;
                height: 7px;
                flex: 0 0 auto;
                border-radius: 50%;
                background: var(--forest);
                box-shadow: 0 0 0 3px var(--forest-soft);
            }

            .hero__title {
                color: var(--ink);
                font-family: "Songti SC", STSong, "Noto Serif SC", "Source Han Serif SC", serif;
                font-size: 22px;
                font-weight: 700;
                line-height: 1.18;
                letter-spacing: 0.01em;
            }

            .hero__detail {
                color: var(--muted);
                font-size: 12.5px;
                line-height: 1.5;
            }

            .queue-summary {
                display: flex;
                align-items: baseline;
                gap: 6px;
                margin: 2px 0 1px;
                padding-left: 9px;
                border-left: 2px solid var(--terracotta);
                color: var(--ink);
                font-size: 12.5px;
            }

            .queue-summary strong {
                font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
                font-size: 13px;
            }

            .main-control {
                display: flex;
                width: 100%;
                min-height: 41px;
                align-items: center;
                justify-content: center;
                gap: 8px;
                margin-top: 5px;
                padding: 10px 14px;
                border: 1px solid var(--action);
                border-radius: 8px;
                background: var(--action);
                color: #fffdf8;
                box-shadow: 0 5px 12px rgba(36, 73, 61, 0.16);
                font-size: 14.5px;
                font-weight: 720;
                letter-spacing: 0.02em;
                cursor: pointer;
                transition: background 140ms ease, transform 140ms ease, box-shadow 140ms ease;
            }

            .control-icon {
                font-size: 16px;
            }

            .main-control:hover {
                background: var(--action-hover);
                box-shadow: 0 6px 15px rgba(36, 73, 61, 0.2);
            }

            .main-control:active {
                transform: translateY(1px);
            }

            .speed-settings {
                display: grid;
                gap: 8px;
                margin-top: 13px;
                padding-top: 11px;
                border-top: 1px solid var(--line);
            }

            .section-heading {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 10px;
            }

            .section-heading__label {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                color: var(--ink);
                font-size: 12.5px;
                font-weight: 700;
            }

            .section-heading__label .icon {
                color: var(--forest);
                font-size: 14px;
            }

            .speed-readout {
                display: inline-flex;
                align-items: baseline;
                gap: 4px;
                color: var(--ink);
            }

            .speed-readout > span {
                font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
                font-size: 20px;
                font-weight: 720;
                line-height: 1;
            }

            .speed-readout small {
                color: var(--muted);
                font-size: 10.5px;
            }

            .speed-slider,
            .queue-limit {
                width: 100%;
                height: 18px;
                margin: 0;
                appearance: none;
                background: transparent;
                cursor: pointer;
            }

            .speed-slider::-webkit-slider-runnable-track,
            .queue-limit::-webkit-slider-runnable-track {
                height: 3px;
                border-radius: 2px;
                background: linear-gradient(
                    to right,
                    var(--terracotta) 0 var(--speed-progress),
                    var(--line-strong) var(--speed-progress) 100%
                );
            }

            .queue-limit::-webkit-slider-runnable-track {
                background: var(--line-strong);
            }

            .speed-slider::-moz-range-track,
            .queue-limit::-moz-range-track {
                height: 3px;
                border: 0;
                border-radius: 2px;
                background: var(--line-strong);
            }

            .speed-slider::-moz-range-progress {
                height: 3px;
                border-radius: 2px;
                background: var(--terracotta);
            }

            .speed-slider::-webkit-slider-thumb,
            .queue-limit::-webkit-slider-thumb {
                width: 14px;
                height: 14px;
                margin-top: -5.5px;
                appearance: none;
                border: 2px solid var(--surface-raised);
                border-radius: 50%;
                background: var(--terracotta);
                box-shadow: 0 0 0 1px var(--terracotta);
            }

            .queue-limit::-webkit-slider-thumb {
                background: var(--forest);
                box-shadow: 0 0 0 1px var(--forest);
            }

            .speed-slider::-moz-range-thumb,
            .queue-limit::-moz-range-thumb {
                width: 11px;
                height: 11px;
                border: 2px solid var(--surface-raised);
                border-radius: 50%;
                background: var(--terracotta);
                box-shadow: 0 0 0 1px var(--terracotta);
            }

            .queue-limit::-moz-range-thumb {
                background: var(--forest);
                box-shadow: 0 0 0 1px var(--forest);
            }

            .tuning-content {
                display: grid;
                gap: 8px;
                padding: 0 0 11px;
            }

            .presets {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                overflow: hidden;
                border: 1px solid var(--line);
                border-radius: 7px;
            }

            .preset {
                min-height: 28px;
                padding: 5px;
                border: 0;
                border-right: 1px solid var(--line);
                background: transparent;
                color: var(--muted);
                font-size: 12px;
                cursor: pointer;
            }

            .preset:last-child {
                border-right: 0;
            }

            .preset:hover {
                background: var(--surface);
                color: var(--ink);
            }

            .preset[aria-pressed="true"] {
                background: var(--forest-soft);
                color: var(--forest-deep);
                font-weight: 700;
            }

            .queue-options {
                display: grid;
                gap: 8px;
                margin-top: 2px;
                padding: 8px 0 0;
                border-top: 1px solid var(--line);
            }

            .queue-control-row {
                display: grid;
                grid-template-columns: 70px minmax(0, 1fr) auto;
                align-items: center;
                gap: 8px;
            }

            .queue-control-row > span {
                color: var(--muted);
                font-size: 11.5px;
            }

            .queue-count {
                min-width: 32px;
                color: var(--ink);
                font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
                font-size: 11px;
                text-align: right;
            }

            .queue-note {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                color: var(--muted);
                font-size: 10.5px;
            }

            .queue-note strong {
                flex: 0 0 auto;
                color: var(--ink);
                font-size: 11px;
                font-weight: 680;
            }

            .queue-stop {
                display: inline-flex;
                width: 100%;
                min-height: 31px;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 5px 8px;
                border: 1px solid var(--danger);
                border-radius: 6px;
                background: transparent;
                color: var(--danger);
                font-size: 11px;
                font-weight: 680;
                cursor: pointer;
            }

            .queue-stop .icon {
                font-size: 13px;
            }

            .fold-panel {
                border-top: 1px solid var(--line);
            }

            .fold-panel:first-of-type {
                margin-top: 11px;
            }

            .fold-panel summary {
                display: flex;
                min-height: 38px;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                color: var(--ink);
                cursor: pointer;
                list-style: none;
            }

            .fold-panel summary::-webkit-details-marker {
                display: none;
            }

            .fold-panel summary > .summary-label {
                display: inline-flex;
                align-items: center;
                gap: 7px;
                font-size: 12.5px;
                font-weight: 700;
            }

            .summary-icon {
                display: grid;
                width: 21px;
                height: 21px;
                place-items: center;
                border: 1px solid var(--line);
                border-radius: 6px;
                background: var(--surface);
                color: var(--muted);
                font-size: 12px;
                transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
            }

            .fold-panel[open] .summary-icon {
                border-color: color-mix(in srgb, var(--forest) 30%, var(--line));
                background: var(--forest-soft);
                color: var(--forest-deep);
            }

            .fold-panel summary > small {
                margin-left: auto;
                color: var(--faint);
                font-size: 10px;
                font-weight: 500;
            }

            .fold-caret {
                color: var(--muted);
                font-size: 11px;
                transition: transform 160ms ease;
            }

            .fold-panel[open] .fold-caret {
                transform: rotate(180deg);
            }

            .stats {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                padding: 1px 0 12px;
            }

            .stat {
                display: grid;
                gap: 3px;
                padding: 4px 8px;
                border-right: 1px solid var(--line);
            }

            .stat:first-child {
                padding-left: 0;
            }

            .stat:last-child {
                padding-right: 0;
                border-right: 0;
            }

            .stat__label {
                color: var(--faint);
                font-size: 9.5px;
            }

            .stat__value {
                overflow: hidden;
                color: var(--ink);
                font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
                font-size: 11.5px;
                font-weight: 720;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .preferences {
                display: grid;
                gap: 1px;
                padding: 0 0 11px;
            }

            .preference {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                align-items: center;
                gap: 10px;
                min-height: 46px;
                cursor: pointer;
            }

            .preference + .preference {
                border-top: 1px solid var(--line);
            }

            .preference__copy {
                display: grid;
                gap: 1px;
            }

            .preference__title {
                color: var(--ink);
                font-size: 11.5px;
                font-weight: 680;
            }

            .preference__detail {
                color: var(--muted);
                font-size: 10px;
            }

            .preference input {
                width: 17px;
                height: 17px;
                margin: 0;
                accent-color: var(--forest);
                cursor: pointer;
            }

            .panel__footer {
                display: flex;
                min-height: 40px;
                flex: 0 0 auto;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 6px 11px 6px 15px;
                border-top: 1px solid var(--line);
                color: var(--faint);
                background: var(--surface);
            }

            .footer-note {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                overflow: hidden;
                font-size: 9.5px;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .footer-note .icon {
                font-size: 13px;
            }

            .reset-button {
                display: inline-flex;
                flex: 0 0 auto;
                align-items: center;
                gap: 4px;
                padding: 4px 6px;
                border: 0;
                border-radius: 4px;
                background: transparent;
                color: var(--muted);
                font-size: 10px;
                cursor: pointer;
            }

            .reset-button .icon {
                font-size: 12px;
            }

            .reset-button:hover {
                background: var(--rail-selected);
                color: var(--ink);
            }

            .dock {
                position: relative;
                display: none;
                width: 46px;
                height: 46px;
                place-items: center;
                padding: 2px;
                border: 0;
                border-radius: 12px;
                background: conic-gradient(
                    var(--terracotta) 0 var(--progress, 0deg),
                    var(--line-strong) var(--progress, 0deg) 1turn
                );
                color: var(--forest-deep);
                box-shadow: var(--shadow);
                cursor: grab;
                touch-action: none;
            }

            .dock::before {
                position: absolute;
                inset: 2px;
                border-radius: 10px;
                background: var(--surface-raised);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--line) 82%, transparent);
                content: "";
            }

            .dock__icon {
                position: relative;
                z-index: 1;
                font-size: 22px;
            }

            .dock__status {
                position: absolute;
                z-index: 2;
                right: 7px;
                bottom: 7px;
                width: 6px;
                height: 6px;
                border: 1px solid var(--surface-raised);
                border-radius: 50%;
                background: var(--faint);
            }

            .shell[data-minimized="true"] .panel {
                display: none;
            }

            .shell[data-minimized="true"] {
                width: 46px;
            }

            .shell[data-minimized="true"] .dock {
                display: grid;
                animation: panel-in 160ms ease-out both;
            }

            .shell[data-state="running"] .state-dot,
            .shell[data-state="loading"] .state-dot,
            .shell[data-state="waiting"] .state-dot,
            .shell[data-state="queue"] .state-dot,
            .shell[data-state="cooldown"] .state-dot,
            .shell[data-state="running"] .dock__status,
            .shell[data-state="loading"] .dock__status,
            .shell[data-state="waiting"] .dock__status,
            .shell[data-state="queue"] .dock__status,
            .shell[data-state="cooldown"] .dock__status {
                background: var(--terracotta);
            }

            .shell[data-state="paused"] .state-dot,
            .shell[data-state="paused"] .dock__status {
                background: var(--faint);
                box-shadow: 0 0 0 3px var(--surface);
            }

            .shell[data-state="done"] .state-dot,
            .shell[data-state="done"] .dock__status {
                background: var(--forest);
            }

            .shell[data-state="running"] .state-dot {
                animation: breathe 1.8s ease-in-out infinite;
            }

            :host([data-dragging="true"]) .panel,
            :host([data-dragging="true"]) .dock {
                box-shadow: 0 24px 56px rgba(33, 43, 36, 0.22), 0 5px 14px rgba(33, 43, 36, 0.12);
            }

            @keyframes panel-in {
                from {
                    opacity: 0;
                    transform: translate(
                        var(--panel-enter-x, 5px),
                        var(--panel-enter-y, -5px)
                    ) scale(0.985);
                }
                to {
                    opacity: 1;
                    transform: translate(0, 0) scale(1);
                }
            }

            @keyframes breathe {
                0%, 100% { opacity: 0.72; }
                50% { opacity: 1; }
            }

            @media (max-width: 390px) {
                .shell,
                .panel {
                    width: min(330px, calc(100vw - 24px));
                }

                .panel {
                    grid-template-columns: 66px minmax(0, 1fr);
                }

                .mode-button {
                    min-height: 78px;
                }

                .panel__body {
                    padding-right: 13px;
                    padding-left: 13px;
                }
            }

            @media (max-height: 520px) {
                .panel,
                .panel__main {
                    max-height: calc(100vh - 24px);
                }

                .mode-button {
                    min-height: 70px;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                *, *::before, *::after {
                    animation-duration: 1ms !important;
                    animation-iteration-count: 1 !important;
                    transition-duration: 1ms !important;
                }
            }
        </style>

        <div class="shell" data-state="idle" data-minimized="${settings.minimized}">
            <section class="panel" aria-label="AutoReadingForLD 阅读控制台">
                <aside class="mode-rail" aria-label="阅读模式">
                    <div class="drag-strip" data-drag-handle title="拖动控制台">
                        ${renderIcon('dotsSixVertical')}
                    </div>
                    <nav class="mode-nav" aria-label="切换阅读模式">
                        ${READING_MODES.map((mode) => `
                            <button
                                class="mode-button"
                                type="button"
                                data-mode="${mode.key}"
                                aria-label="${mode.label}：${mode.detail}"
                                aria-pressed="false"
                                title="${mode.detail}"
                            >
                                ${renderIcon(mode.icon, 'icon mode-icon')}
                                <strong>${mode.label}</strong>
                            </button>
                        `).join('')}
                    </nav>
                    <div class="rail-shortcut" title="开始或暂停阅读">
                        <kbd>Alt+S</kbd>
                    </div>
                </aside>

                <div class="panel__main">
                    <header class="panel__header" data-drag-handle>
                        <div class="brand">
                            <span class="brand__name">自动阅读</span>
                            <span class="brand__meta">LINUX DO · ${APP.version}</span>
                        </div>
                        <button class="minimize-button" type="button" data-action="minimize" aria-label="收起阅读控制台" title="收起（Alt + M）">
                            ${renderIcon('minus')}
                        </button>
                    </header>

                    <main class="panel__body">
                        <section class="hero" aria-labelledby="reading-state-title">
                            <div class="state-line" role="status" aria-live="polite">
                                <span class="state-dot" aria-hidden="true"></span>
                                <span data-role="state-chip">待机</span>
                            </div>
                            <strong class="hero__title" id="reading-state-title" data-role="state-title">准备就绪</strong>
                            <span class="hero__detail" data-role="state-detail">按 Alt + S 开始阅读</span>
                            <div class="queue-summary" data-role="queue-summary" hidden>
                                <strong><span data-role="queue-summary-count">${settings.queueLimit}</span> 篇</strong>
                                <span>· 每篇间隔 ${CONFIG.queueCooldownMs / 1000} 秒</span>
                            </div>
                            <button class="main-control" type="button" data-action="toggle" aria-label="开始自动阅读">
                                ${renderIcon('play', 'icon control-icon', 'data-icon-state="play"')}
                                ${renderIcon('pause', 'icon control-icon', 'data-icon-state="pause" hidden')}
                                ${renderIcon('stop', 'icon control-icon', 'data-icon-state="stop" hidden')}
                                <span data-role="control-label">开始阅读</span>
                            </button>
                        </section>

                        <section class="speed-settings" aria-labelledby="speed-heading">
                            <div class="section-heading">
                                <span class="section-heading__label" id="speed-heading">
                                    ${renderIcon('speedometer')}
                                    <span>平均阅读速度</span>
                                </span>
                                <span class="speed-readout"><span data-role="speed-value">${settings.speed}</span><small>像素/秒</small></span>
                            </div>
                            <input
                                class="speed-slider"
                                data-role="speed-slider"
                                type="range"
                                min="${CONFIG.minSpeed}"
                                max="${CONFIG.maxSpeed}"
                                step="${CONFIG.speedStep}"
                                value="${settings.speed}"
                                aria-label="平均阅读速度"
                            >
                        </section>

                        <details class="fold-panel tuning-panel">
                            <summary>
                                <span class="summary-label">
                                    <span class="summary-icon">${renderIcon('slidersHorizontal')}</span>
                                    <span>阅读参数</span>
                                </span>
                                <small>速度预设 · 队列</small>
                                ${renderIcon('caretDown', 'icon fold-caret')}
                            </summary>
                            <div class="tuning-content">
                                <div class="presets" aria-label="速度预设">
                                    ${SPEED_PRESETS.map((preset) => `
                                        <button class="preset" type="button" data-speed="${preset.speed}" aria-pressed="false">
                                            ${preset.label}
                                        </button>
                                    `).join('')}
                                </div>

                                <div class="queue-options" data-role="queue-options" hidden>
                                    <div class="queue-control-row">
                                        <span>连续篇数</span>
                                        <input
                                            class="queue-limit"
                                            data-role="queue-limit"
                                            type="range"
                                            min="${CONFIG.queueMinItems}"
                                            max="${CONFIG.queueMaxItems}"
                                            step="1"
                                            value="${settings.queueLimit}"
                                            aria-label="连续阅读篇数上限"
                                        >
                                        <strong class="queue-count" data-role="queue-count">${settings.queueLimit} 篇</strong>
                                    </div>
                                    <div class="queue-note">
                                        <span>按列表顺序读取，每篇完成后前台冷却</span>
                                        <strong>${CONFIG.queueCooldownMs / 1000} 秒</strong>
                                    </div>
                                    <button class="queue-stop" type="button" data-action="stop-queue" data-role="queue-stop" hidden>
                                        ${renderIcon('stop')}
                                        <span>停止连续阅读</span>
                                    </button>
                                </div>
                            </div>
                        </details>

                        <details class="fold-panel stats-panel">
                            <summary>
                                <span class="summary-label">
                                    <span class="summary-icon">${renderIcon('chartLineUp')}</span>
                                    <span>本次统计</span>
                                </span>
                                <small>进度 · 用时 · 行程</small>
                                ${renderIcon('caretDown', 'icon fold-caret')}
                            </summary>
                            <div class="stats" aria-label="本次阅读统计">
                                <div class="stat">
                                    <span class="stat__label">进度</span>
                                    <strong class="stat__value" data-role="progress-value">0%</strong>
                                </div>
                                <div class="stat">
                                    <span class="stat__label">用时</span>
                                    <strong class="stat__value" data-role="time-value">00:00</strong>
                                </div>
                                <div class="stat">
                                    <span class="stat__label">行程</span>
                                    <strong class="stat__value" data-role="distance-value">0.0 屏</strong>
                                </div>
                            </div>
                        </details>

                        <details class="fold-panel protection-panel">
                            <summary>
                                <span class="summary-label">
                                    <span class="summary-icon">${renderIcon('shieldCheck')}</span>
                                    <span>阅读保护</span>
                                </span>
                                <small>后台与手动操作</small>
                                ${renderIcon('caretDown', 'icon fold-caret')}
                            </summary>
                            <div class="preferences">
                                <label class="preference">
                                    <span class="preference__copy">
                                        <span class="preference__title">切到后台时暂停</span>
                                        <span class="preference__detail">避免后台标签页继续滚动</span>
                                    </span>
                                    <input type="checkbox" data-setting="autoPauseOnHidden" ${settings.autoPauseOnHidden ? 'checked' : ''}>
                                </label>

                                <label class="preference">
                                    <span class="preference__copy">
                                        <span class="preference__title">手动操作时暂停</span>
                                        <span class="preference__detail">滚轮、触摸或翻页键触发</span>
                                    </span>
                                    <input type="checkbox" data-setting="pauseOnManualInput" ${settings.pauseOnManualInput ? 'checked' : ''}>
                                </label>
                            </div>
                        </details>
                    </main>

                    <footer class="panel__footer">
                        <span class="footer-note">${renderIcon('waveSine')}自然变速范围 ±12%</span>
                        <button class="reset-button" type="button" data-action="reset-position" title="恢复默认位置">
                            ${renderIcon('arrowCounterClockwise')}
                            <span>复位位置</span>
                        </button>
                    </footer>
                </div>
            </section>

            <button class="dock" type="button" data-action="expand" data-drag-handle aria-label="展开 AutoReadingForLD 阅读控制台" title="展开阅读控制台">
                ${renderIcon('bookOpenText', 'icon dock__icon')}
                <span class="dock__status" aria-hidden="true"></span>
            </button>
        </div>
    `;

    document.body.appendChild(host);

    const refs = {
        shell: shadow.querySelector('.shell'),
        panel: shadow.querySelector('.panel'),
        dock: shadow.querySelector('.dock'),
        toggleButton: shadow.querySelector('[data-action="toggle"]'),
        controlIcons: [...shadow.querySelectorAll('[data-icon-state]')],
        controlLabel: shadow.querySelector('[data-role="control-label"]'),
        stateChip: shadow.querySelector('[data-role="state-chip"]'),
        stateTitle: shadow.querySelector('[data-role="state-title"]'),
        stateDetail: shadow.querySelector('[data-role="state-detail"]'),
        modeButtons: [...shadow.querySelectorAll('[data-mode]')],
        speedSlider: shadow.querySelector('[data-role="speed-slider"]'),
        speedValue: shadow.querySelector('[data-role="speed-value"]'),
        queueSummary: shadow.querySelector('[data-role="queue-summary"]'),
        queueSummaryCount: shadow.querySelector('[data-role="queue-summary-count"]'),
        queueOptions: shadow.querySelector('[data-role="queue-options"]'),
        queueLimit: shadow.querySelector('[data-role="queue-limit"]'),
        queueCount: shadow.querySelector('[data-role="queue-count"]'),
        queueStop: shadow.querySelector('[data-role="queue-stop"]'),
        progressValue: shadow.querySelector('[data-role="progress-value"]'),
        timeValue: shadow.querySelector('[data-role="time-value"]'),
        distanceValue: shadow.querySelector('[data-role="distance-value"]'),
        presetButtons: [...shadow.querySelectorAll('[data-speed]')]
    };

    function syncTheme() {
        const background = getComputedStyle(document.body).backgroundColor;
        const channels = background.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
        const [red = 255, green = 255, blue = 255] = channels;
        const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
        const classSuggestsDark = document.documentElement.classList.contains('dark')
            || document.body.classList.contains('dark')
            || document.documentElement.dataset.colorScheme === 'dark';
        host.dataset.theme = classSuggestsDark || luminance < 0.46 ? 'dark' : 'light';
    }

    function getShellLayoutRect() {
        const width = refs.shell.offsetWidth;
        const height = refs.shell.offsetHeight;
        const inlineLeft = Number.parseFloat(host.style.left);
        const inlineTop = Number.parseFloat(host.style.top);
        const inlineRight = Number.parseFloat(host.style.right);
        const inlineBottom = Number.parseFloat(host.style.bottom);
        const fallbackRect = host.getBoundingClientRect();

        // 定位只读取宿主的布局坐标，避免展开动画的 transform 或后台降帧污染锚点。
        const left = Number.isFinite(inlineLeft)
            ? inlineLeft
            : Number.isFinite(inlineRight)
                ? window.innerWidth - inlineRight - width
                : fallbackRect.left;
        const top = Number.isFinite(inlineTop)
            ? inlineTop
            : Number.isFinite(inlineBottom)
                ? window.innerHeight - inlineBottom - height
                : fallbackRect.top;

        return {
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height
        };
    }

    function setMinimized(minimized, persist = true) {
        const nextMinimized = Boolean(minimized);
        if (nextMinimized === settings.minimized) {
            requestAnimationFrame(() => dragController.clampToViewport());
            return;
        }

        const sourceRect = getShellLayoutRect();
        const anchorRight = sourceRect.left + sourceRect.width / 2 >= window.innerWidth / 2;
        const anchorBottom = sourceRect.top + sourceRect.height / 2 >= window.innerHeight / 2;

        // 展开方向跟随收起入口所在象限，避免固定向右下生长，也减少状态切换时的位置跳变。
        host.style.setProperty('--panel-origin-x', anchorRight ? '100%' : '0%');
        host.style.setProperty('--panel-origin-y', anchorBottom ? '100%' : '0%');
        host.style.setProperty('--panel-enter-x', anchorRight ? '5px' : '-5px');
        host.style.setProperty('--panel-enter-y', anchorBottom ? '5px' : '-5px');

        settings.minimized = nextMinimized;
        refs.shell.dataset.minimized = String(settings.minimized);

        // offsetWidth / offsetHeight 会同步刷新切换后的布局，避免连续点击时遗留定位帧覆盖复位结果。
        const targetRect = getShellLayoutRect();
        dragController.setPosition({
            left: anchorRight ? sourceRect.right - targetRect.width : sourceRect.left,
            top: anchorBottom ? sourceRect.bottom - targetRect.height : sourceRect.top
        }, persist);
    }

    function setSpeed(speed, persist = true) {
        const nextSpeed = clamp(Number(speed), CONFIG.minSpeed, CONFIG.maxSpeed);
        settings.speed = nextSpeed;
        refs.speedSlider.value = String(nextSpeed);
        refs.speedValue.textContent = String(Math.round(nextSpeed));

        const ratio = ((nextSpeed - CONFIG.minSpeed) / (CONFIG.maxSpeed - CONFIG.minSpeed)) * 100;
        refs.shell.style.setProperty('--speed-progress', `${ratio}%`);
        refs.presetButtons.forEach((button) => {
            button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === nextSpeed));
        });

        if (persist) {
            StorageManager.save(settings);
        }
    }

    function setMode(mode, persist = true) {
        const selected = READING_MODES.find((item) => item.key === mode) || READING_MODES[0];
        settings.mode = selected.key;
        refs.modeButtons.forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.mode === selected.key));
        });
        refs.queueSummary.hidden = selected.key !== 'queue';
        refs.queueOptions.hidden = selected.key !== 'queue';

        if (persist) {
            StorageManager.save(settings);
        }

        requestAnimationFrame(() => dragController?.clampToViewport());
    }

    function setQueueLimit(limit, persist = true) {
        const nextLimit = clamp(
            Math.round(Number(limit) || CONFIG.queueDefaultItems),
            CONFIG.queueMinItems,
            CONFIG.queueMaxItems
        );
        settings.queueLimit = nextLimit;
        refs.queueLimit.value = String(nextLimit);
        refs.queueCount.textContent = `${nextLimit} 篇`;
        refs.queueSummaryCount.textContent = String(nextLimit);

        if (persist) {
            StorageManager.save(settings);
        }
    }

    let queueUiActive = false;
    function setQueueActiveUi(active) {
        queueUiActive = Boolean(active);
        refs.queueStop.hidden = !queueUiActive;
    }

    function createDragController() {
        let dragging = false;
        let moved = false;
        let suppressClickUntil = 0;
        let pointerId = null;
        let startPointer = { x: 0, y: 0 };
        let startPosition = { left: 0, top: 0 };

        function panelRect() {
            return getShellLayoutRect();
        }

        function positionPadding() {
            // 收起入口只需保持自身可见，不需要为展开面板预留活动区域。
            return settings.minimized ? 0 : CONFIG.edgePadding;
        }

        function clampPosition(left, top) {
            const rect = panelRect();
            const padding = positionPadding();
            const maxLeft = Math.max(padding, window.innerWidth - rect.width - padding);
            const maxTop = Math.max(padding, window.innerHeight - rect.height - padding);

            return {
                left: clamp(left, padding, maxLeft),
                top: clamp(top, padding, maxTop)
            };
        }

        function applyPosition(position, persist = false) {
            const next = clampPosition(position.left, position.top);
            host.style.left = `${next.left}px`;
            host.style.top = `${next.top}px`;
            host.style.right = 'auto';
            settings.position = next;

            if (persist) {
                StorageManager.save(settings);
            }
        }

        function snapAndSave() {
            const rect = panelRect();
            let left = rect.left;
            let top = rect.top;

            if (settings.minimized) {
                applyPosition({ left, top }, true);
                return;
            }

            const padding = positionPadding();
            const rightGap = window.innerWidth - rect.right;
            const bottomGap = window.innerHeight - rect.bottom;

            if (rect.left <= padding + CONFIG.snapThreshold) {
                left = padding;
            } else if (rightGap <= padding + CONFIG.snapThreshold) {
                left = window.innerWidth - rect.width - padding;
            }

            if (rect.top <= padding + CONFIG.snapThreshold) {
                top = padding;
            } else if (bottomGap <= padding + CONFIG.snapThreshold) {
                top = window.innerHeight - rect.height - padding;
            }

            applyPosition({ left, top }, true);
        }

        function onPointerDown(event) {
            const handle = event.currentTarget;
            if (event.button !== 0 || event.target.closest('button:not(.dock), input, label')) {
                return;
            }

            const rect = panelRect();
            dragging = true;
            moved = false;
            pointerId = event.pointerId;
            startPointer = { x: event.clientX, y: event.clientY };
            startPosition = { left: rect.left, top: rect.top };
            host.dataset.dragging = 'true';
            handle.setPointerCapture?.(pointerId);
        }

        function onPointerMove(event) {
            if (!dragging || event.pointerId !== pointerId) {
                return;
            }

            const deltaX = event.clientX - startPointer.x;
            const deltaY = event.clientY - startPointer.y;
            if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
                moved = true;
            }

            applyPosition({
                left: startPosition.left + deltaX,
                top: startPosition.top + deltaY
            });
            event.preventDefault();
        }

        function onPointerUp(event) {
            if (!dragging || event.pointerId !== pointerId) {
                return;
            }

            dragging = false;
            host.dataset.dragging = 'false';
            event.currentTarget.releasePointerCapture?.(pointerId);
            pointerId = null;

            if (moved) {
                suppressClickUntil = performance.now() + 240;
                snapAndSave();
            }
        }

        shadow.querySelectorAll('[data-drag-handle]').forEach((handle) => {
            handle.addEventListener('pointerdown', onPointerDown);
            handle.addEventListener('pointermove', onPointerMove);
            handle.addEventListener('pointerup', onPointerUp);
            handle.addEventListener('pointercancel', onPointerUp);
        });

        return {
            wasRecentDrag() {
                return performance.now() < suppressClickUntil;
            },

            clampToViewport() {
                const rect = panelRect();
                if (settings.position || rect.left < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
                    applyPosition({ left: rect.left, top: rect.top }, Boolean(settings.position));
                }
            },

            setPosition(position, persist = true) {
                applyPosition(position, persist);
            },

            restore() {
                if (settings.position) {
                    applyPosition(settings.position);
                }
            },

            reset() {
                settings.position = null;
                host.style.setProperty('--panel-origin-x', '100%');
                host.style.setProperty('--panel-origin-y', '0%');
                host.style.setProperty('--panel-enter-x', '5px');
                host.style.setProperty('--panel-enter-y', '-5px');
                host.style.left = 'auto';
                host.style.top = '96px';
                host.style.right = '20px';
                StorageManager.save(settings);
                requestAnimationFrame(() => this.clampToViewport());
            }
        };
    }

    const dragController = createDragController();
    dragController.restore();

    const foldPanels = [...shadow.querySelectorAll('.fold-panel')];
    foldPanels.forEach((panel) => {
        panel.addEventListener('toggle', () => {
            // 小尺寸控制台一次只展开一个低频区域，避免遮挡帖子正文。
            if (panel.open) {
                foldPanels.forEach((otherPanel) => {
                    if (otherPanel !== panel) {
                        otherPanel.open = false;
                    }
                });
            }
            requestAnimationFrame(() => dragController.clampToViewport());
        });
    });

    let handleScrollDone = () => {};

    function createScrollController() {
        let state = 'idle';
        let running = false;
        let frameId = null;
        let lastFrameAt = 0;
        let lastHeight = getScrollMetrics().height;
        let bottomReachedAt = 0;
        let currentSpeed = 0;
        let speedMultiplier = 1;
        let nextSpeedVariationAt = 0;
        let distance = 0;
        let elapsedBeforeRun = 0;
        let activeSince = 0;
        let lastUiRefreshAt = 0;
        let detailOverride = '';

        function elapsed() {
            return elapsedBeforeRun + (running && activeSince ? performance.now() - activeSince : 0);
        }

        function scheduleSpeedVariation(timestamp) {
            const range = CONFIG.speedVariationMax - CONFIG.speedVariationMin;
            speedMultiplier = CONFIG.speedVariationMin + Math.random() * range;
            const intervalRange = CONFIG.speedVariationIntervalMaxMs - CONFIG.speedVariationIntervalMinMs;
            nextSpeedVariationAt = timestamp
                + CONFIG.speedVariationIntervalMinMs
                + Math.random() * intervalRange;
        }

        function setState(nextState, detail = '') {
            state = nextState;
            detailOverride = detail;
            renderState();
        }

        function renderState() {
            const copy = STATE_COPY[state] || STATE_COPY.idle;
            const queueActionActive = queueUiActive && isListRoute() && settings.mode === 'queue';
            refs.shell.dataset.state = state;
            refs.stateChip.textContent = copy.chip;
            refs.stateTitle.textContent = copy.title;
            refs.stateDetail.textContent = detailOverride || copy.detail;
            const controlIconState = queueActionActive ? 'stop' : running ? 'pause' : 'play';
            refs.controlIcons.forEach((icon) => {
                icon.toggleAttribute('hidden', icon.dataset.iconState !== controlIconState);
            });
            refs.controlLabel.textContent = queueActionActive
                ? '停止连续阅读'
                : running
                    ? '暂停阅读'
                    : '开始阅读';
            refs.toggleButton.setAttribute(
                'aria-label',
                queueActionActive ? '停止连续阅读' : running ? '暂停自动阅读' : '开始自动阅读'
            );
            refs.dock.title = `${copy.title} · 点击展开`;
        }

        function renderStats(force = false, timestamp = performance.now()) {
            if (!force && timestamp - lastUiRefreshAt < CONFIG.uiRefreshMs) {
                return;
            }

            lastUiRefreshAt = timestamp;
            const metrics = getScrollMetrics();
            const roundedProgress = Math.round(metrics.progress);
            refs.progressValue.textContent = `${roundedProgress}%`;
            refs.timeValue.textContent = formatTime(elapsed());
            refs.distanceValue.textContent = formatScreens(distance);
            refs.shell.style.setProperty('--progress', `${metrics.progress * 3.6}deg`);
            refs.shell.style.setProperty('--progress-percent', `${metrics.progress}%`);
        }

        function stop(nextState = 'paused', detail = '') {
            const wasRunning = running;
            if (running && activeSince) {
                elapsedBeforeRun += performance.now() - activeSince;
            }

            running = false;
            activeSince = 0;
            currentSpeed = 0;
            bottomReachedAt = 0;

            if (frameId !== null) {
                cancelAnimationFrame(frameId);
                frameId = null;
            }

            setState(nextState, detail);
            renderStats(true);

            if (wasRunning && nextState === 'done') {
                queueMicrotask(() => handleScrollDone());
            }
        }

        function tick(timestamp) {
            if (!running) {
                return;
            }

            if (!isTopicRoute()) {
                stop('paused', '已离开帖子页面');
                return;
            }

            const deltaSeconds = clamp((timestamp - lastFrameAt) / 1000, 0, 0.08);
            lastFrameAt = timestamp;
            if (timestamp >= nextSpeedVariationAt) {
                scheduleSpeedVariation(timestamp);
            }

            // 设定值代表长期平均速度；小幅、缓慢的变化用于减少机械感，不用于模拟点击或规避检测。
            const targetSpeed = settings.speed * speedMultiplier;
            currentSpeed += (targetSpeed - currentSpeed) * Math.min(1, deltaSeconds * 1.8);

            const before = getScrollMetrics();
            const heightGrew = before.height > lastHeight + 2;
            lastHeight = before.height;

            if (heightGrew) {
                bottomReachedAt = 0;
                setState('loading');
            }

            if (before.remaining > CONFIG.bottomThreshold) {
                bottomReachedAt = 0;
                if (!heightGrew && state !== 'running') {
                    setState('running');
                }

                window.scrollBy(0, currentSpeed * deltaSeconds);
            } else {
                if (!bottomReachedAt) {
                    bottomReachedAt = timestamp;
                }

                const waited = timestamp - bottomReachedAt;
                const remainingWait = Math.max(0, CONFIG.bottomWaitMs - waited);
                if (remainingWait <= 0) {
                    stop('done');
                    return;
                }

                setState('waiting', `等待懒加载 · ${Math.ceil(remainingWait / 1000)} 秒`);
                // 持续贴近底部，以便触发 Discourse 的懒加载观察器。
                window.scrollTo(0, before.maximum);
            }

            const after = getScrollMetrics();
            distance += Math.abs(after.top - before.top);
            renderStats(false, timestamp);
            frameId = requestAnimationFrame(tick);
        }

        function start() {
            if (running || !isTopicRoute()) {
                return;
            }

            running = true;
            activeSince = performance.now();
            lastFrameAt = activeSince;
            lastHeight = getScrollMetrics().height;
            bottomReachedAt = 0;
            currentSpeed = Math.min(settings.speed, Math.max(8, settings.speed * 0.35));
            speedMultiplier = 1;
            nextSpeedVariationAt = activeSince + CONFIG.speedVariationIntervalMinMs;
            setState('running');
            frameId = requestAnimationFrame(tick);
        }

        function toggle() {
            if (running) {
                stop('paused');
            } else {
                start();
            }
        }

        function resetForRoute() {
            stop('idle');
            distance = 0;
            elapsedBeforeRun = 0;
            lastHeight = getScrollMetrics().height;
            renderStats(true);
        }

        renderState();
        renderStats(true);

        return {
            toggle,
            start,
            pause(detail = '') {
                if (running) {
                    stop('paused', detail);
                }
            },
            resetForRoute,
            showState(nextState, detail = '') {
                setState(nextState, detail);
            },
            updateStats() {
                renderStats();
            },
            isRunning() {
                return running;
            }
        };
    }

    const scrollController = createScrollController();

    function normalizeTopicUrl(value) {
        try {
            const url = new URL(value, window.location.origin);
            if (url.origin !== window.location.origin) {
                return null;
            }

            const match = url.pathname.match(/^\/(?:t|n)\/(?:[^/]+\/)?(\d+)/);
            if (!match) {
                return null;
            }

            // 队列始终从话题入口开始，不继承楼层、查询参数或锚点。
            url.pathname = match[0];
            url.search = '';
            url.hash = '';
            return { id: match[1], url: url.href };
        } catch {
            return null;
        }
    }

    function topicIdFromUrl(value) {
        return normalizeTopicUrl(value)?.id || '';
    }

    function normalizeListUrl(value) {
        try {
            const url = new URL(value, window.location.origin);
            if (url.origin !== window.location.origin || !/^\/(?:new|unread|unseen|latest)(?:\/|$)/.test(url.pathname)) {
                return '';
            }

            url.hash = '';
            return url.href;
        } catch {
            return '';
        }
    }

    function collectTopicsFromList(limit) {
        const topics = [];
        const seen = new Set();
        const rows = document.querySelectorAll('tr.topic-list-item, .topic-list-item');
        const requireUnreadMarker = /^\/(?:latest|unseen)(?:\/|$)/.test(window.location.pathname);

        for (const row of rows) {
            if (topics.length >= limit) {
                break;
            }

            if (requireUnreadMarker) {
                const isUnread = row.matches('.unseen-topic, .visited:not(.read)')
                    || Boolean(row.querySelector('.unread-posts, .new-topic, .read-state:not(.read), .badge-notification.new-posts'));
                if (!isUnread) {
                    continue;
                }
            }

            const anchor = row.querySelector('a.title, a.raw-topic-link, a[data-topic-id]');
            if (!anchor?.href) {
                continue;
            }

            const normalizedTopic = normalizeTopicUrl(anchor.href);
            if (!normalizedTopic || seen.has(normalizedTopic.id)) {
                continue;
            }

            seen.add(normalizedTopic.id);
            topics.push({
                id: normalizedTopic.id,
                url: normalizedTopic.url,
                title: anchor.textContent?.trim() || `话题 ${normalizedTopic.id}`
            });
        }

        return topics;
    }

    const QueueStorage = {
        empty() {
            return {
                active: false,
                items: [],
                index: 0,
                phase: 'idle',
                sourceUrl: '',
                startedAt: 0,
                updatedAt: 0,
                cooldownRemainingMs: CONFIG.queueCooldownMs
            };
        },

        normalize(raw) {
            const empty = this.empty();
            const items = Array.isArray(raw?.items)
                ? raw.items
                    .map((item) => {
                        const normalizedTopic = item && normalizeTopicUrl(item.url);
                        return normalizedTopic
                            ? {
                                id: normalizedTopic.id,
                                url: normalizedTopic.url,
                                title: String(item.title || `话题 ${normalizedTopic.id}`)
                            }
                            : null;
                    })
                    .filter(Boolean)
                    .slice(0, CONFIG.queueMaxItems)
                : [];
            const updatedAt = Number(raw?.updatedAt) || 0;
            const stale = !updatedAt || Date.now() - updatedAt > CONFIG.queueMaxAgeMs;

            return {
                active: Boolean(raw?.active) && items.length > 0 && !stale,
                items,
                index: clamp(Math.floor(Number(raw?.index) || 0), 0, Math.max(0, items.length - 1)),
                phase: ['reading', 'cooldown'].includes(raw?.phase) ? raw.phase : empty.phase,
                sourceUrl: normalizeListUrl(raw?.sourceUrl),
                startedAt: Number(raw?.startedAt) || 0,
                updatedAt,
                cooldownRemainingMs: clamp(
                    Number(raw?.cooldownRemainingMs) || CONFIG.queueCooldownMs,
                    0,
                    CONFIG.queueCooldownMs
                )
            };
        },

        load() {
            try {
                const text = localStorage.getItem(APP.queueStorageKey);
                return text ? this.normalize(JSON.parse(text)) : this.empty();
            } catch (error) {
                console.warn(`[${APP.name}] 连续阅读队列读取失败。`, error);
                return this.empty();
            }
        },

        save(session) {
            const normalized = this.normalize({ ...session, updatedAt: Date.now() });
            try {
                localStorage.setItem(APP.queueStorageKey, JSON.stringify(normalized));
            } catch (error) {
                console.warn(`[${APP.name}] 连续阅读队列保存失败。`, error);
            }
            return normalized;
        },

        clear() {
            localStorage.removeItem(APP.queueStorageKey);
        }
    };

    function createQueueManager() {
        let session = QueueStorage.load();
        let cooldownFrame = null;
        let navigationTimer = null;
        let cooldownLastAt = 0;
        let lastCooldownSaveSecond = -1;

        function currentItem() {
            return session.items[session.index] || null;
        }

        function queueLabel() {
            return session.items.length > 0
                ? `队列 ${Math.min(session.index + 1, session.items.length)}/${session.items.length}`
                : '队列未建立';
        }

        function save() {
            session = QueueStorage.save(session);
            setQueueActiveUi(session.active);
        }

        function cancelTimers() {
            if (cooldownFrame !== null) {
                cancelAnimationFrame(cooldownFrame);
                cooldownFrame = null;
            }
            if (navigationTimer !== null) {
                clearTimeout(navigationTimer);
                navigationTimer = null;
            }
        }

        function navigateToCurrent() {
            const item = currentItem();
            if (!session.active || !item) {
                complete();
                return;
            }

            session.phase = 'reading';
            session.cooldownRemainingMs = CONFIG.queueCooldownMs;
            save();
            window.location.assign(item.url);
        }

        function complete() {
            const returnUrl = session.sourceUrl;
            cancelTimers();
            session.active = false;
            session.phase = 'idle';
            save();
            scrollController.showState('done', `连续阅读完成 · 共 ${session.items.length} 篇`);

            if (isTopicRoute() && returnUrl) {
                navigationTimer = window.setTimeout(() => {
                    window.location.assign(returnUrl);
                }, 1600);
            }
        }

        function stop(detail = '连续阅读已停止') {
            cancelTimers();
            session.active = false;
            session.phase = 'idle';
            save();
            scrollController.pause(detail);
            scrollController.showState('paused', detail);
        }

        function beginCooldown() {
            if (!session.active || session.phase === 'cooldown') {
                return;
            }

            session.phase = 'cooldown';
            session.cooldownRemainingMs = CONFIG.queueCooldownMs;
            cooldownLastAt = performance.now();
            save();
            runCooldown();
        }

        function runCooldown() {
            cancelTimers();
            cooldownLastAt = performance.now();
            lastCooldownSaveSecond = -1;

            const step = (timestamp) => {
                if (!session.active || session.phase !== 'cooldown') {
                    cooldownFrame = null;
                    return;
                }

                // requestAnimationFrame 在后台可能完全停摆；限制单帧扣减，确保只计算可见前台时间。
                const delta = Math.min(timestamp - cooldownLastAt, 250);
                cooldownLastAt = timestamp;
                if (!document.hidden) {
                    session.cooldownRemainingMs = Math.max(0, session.cooldownRemainingMs - delta);
                }

                if (document.hidden) {
                    scrollController.showState('cooldown', `${queueLabel()} · 回到页面后继续冷却`);
                } else {
                    scrollController.showState(
                        'cooldown',
                        `${queueLabel()} · ${Math.ceil(session.cooldownRemainingMs / 1000)} 秒后进入下一篇`
                    );
                }

                if (session.cooldownRemainingMs <= 0) {
                    session.index += 1;
                    if (session.index >= session.items.length) {
                        complete();
                        return;
                    }

                    session.phase = 'reading';
                    session.cooldownRemainingMs = CONFIG.queueCooldownMs;
                    save();
                    navigationTimer = window.setTimeout(navigateToCurrent, 250);
                    return;
                }

                const cooldownSecond = Math.ceil(session.cooldownRemainingMs / 1000);
                if (cooldownSecond !== lastCooldownSaveSecond) {
                    lastCooldownSaveSecond = cooldownSecond;
                    save();
                }
                cooldownFrame = requestAnimationFrame(step);
            };

            cooldownFrame = requestAnimationFrame(step);
        }

        function startFromList() {
            if (!isListRoute()) {
                scrollController.showState('idle', '请先打开新帖、未读或最新列表');
                return;
            }

            const items = collectTopicsFromList(settings.queueLimit);
            if (items.length === 0) {
                scrollController.showState('idle', '当前列表没有可加入队列的未读帖子');
                return;
            }

            cancelTimers();
            session = {
                active: true,
                items,
                index: 0,
                phase: 'reading',
                sourceUrl: window.location.href,
                startedAt: Date.now(),
                updatedAt: Date.now(),
                cooldownRemainingMs: CONFIG.queueCooldownMs
            };
            save();
            scrollController.showState('queue', `已收集 ${items.length} 篇 · 即将进入第 1 篇`);
            navigationTimer = window.setTimeout(navigateToCurrent, 700);
        }

        function currentTopicMatchesQueue() {
            const item = currentItem();
            return Boolean(item && topicIdFromUrl(window.location.href) === item.id);
        }

        function onRouteReady() {
            session = QueueStorage.load();
            setQueueActiveUi(session.active);

            if (!session.active) {
                return false;
            }

            if (settings.mode !== 'queue') {
                setMode('queue');
            }

            if (isListRoute()) {
                scrollController.showState('queue', `${queueLabel()} · 准备继续`);
                navigationTimer = window.setTimeout(navigateToCurrent, 700);
                return true;
            }

            if (!isTopicRoute() || !currentTopicMatchesQueue()) {
                stop('连续阅读已停止：当前页面不在队列中');
                return false;
            }

            if (session.phase === 'cooldown') {
                runCooldown();
                return true;
            }

            scrollController.showState('queue', `${queueLabel()} · 正在准备正文`);
            return true;
        }

        setQueueActiveUi(session.active);

        return {
            startFromList,
            stop,
            onRouteReady,
            onTopicDone() {
                if (session.active && currentTopicMatchesQueue()) {
                    beginCooldown();
                }
            },
            isActive() {
                return session.active;
            },
            shouldAutoStartCurrentTopic() {
                return session.active && session.phase === 'reading' && currentTopicMatchesQueue();
            },
            describe() {
                return queueLabel();
            }
        };
    }

    const queueManager = createQueueManager();
    handleScrollDone = () => queueManager.onTopicDone();

    function waitForTopicContent(timeoutMs = 12000) {
        const selector = '.topic-post, [data-post-id], #topic-title, article';
        if (document.querySelector(selector)) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                observer.disconnect();
                clearTimeout(timeoutId);
                resolve(value);
            };
            const observer = new MutationObserver(() => {
                if (document.querySelector(selector)) {
                    finish(true);
                }
            });
            const timeoutId = window.setTimeout(() => finish(false), timeoutMs);
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    let routeActivation = 0;
    let pendingVisibleAutoStart = false;
    async function activateCurrentRoute() {
        const activation = ++routeActivation;
        const supported = isSupportedRoute();
        host.hidden = !supported;
        scrollController.resetForRoute();

        if (!supported) {
            pendingVisibleAutoStart = false;
            return;
        }

        const queueHandled = queueManager.onRouteReady();
        if (isListRoute()) {
            if (!queueHandled) {
                if (settings.mode === 'queue') {
                    scrollController.showState('idle', '点击主按钮建立连续阅读队列');
                } else {
                    scrollController.showState('idle', '请手动打开一个帖子开始阅读');
                }
            }
            return;
        }

        const shouldStart = queueManager.shouldAutoStartCurrentTopic()
            || (!queueManager.isActive() && settings.mode === 'auto');
        if (!shouldStart) {
            pendingVisibleAutoStart = false;
            return;
        }

        if (settings.autoPauseOnHidden && document.hidden) {
            pendingVisibleAutoStart = true;
            scrollController.showState('paused', '页面在后台，回到页面后再开始');
            return;
        }

        pendingVisibleAutoStart = false;

        const ready = await waitForTopicContent();
        if (activation !== routeActivation || !isTopicRoute()) {
            return;
        }

        if (!ready) {
            if (queueManager.isActive()) {
                queueManager.stop('正文加载超时，连续阅读已停止');
            } else {
                scrollController.showState('paused', '正文加载超时，请手动重试');
            }
            return;
        }

        scrollController.start();
    }

    function handlePrimaryAction() {
        if (isListRoute()) {
            if (settings.mode !== 'queue') {
                scrollController.showState('idle', '当前模式需要先手动打开帖子');
                return;
            }

            if (queueManager.isActive()) {
                queueManager.stop();
            } else {
                queueManager.startFromList();
            }
            return;
        }

        scrollController.toggle();
    }

    shadow.addEventListener('click', (event) => {
        const actionElement = event.target.closest('[data-action]');
        if (!actionElement) {
            return;
        }

        const action = actionElement.dataset.action;
        if (action === 'toggle') {
            handlePrimaryAction();
        } else if (action === 'minimize') {
            setMinimized(true);
        } else if (action === 'expand') {
            if (!dragController.wasRecentDrag()) {
                setMinimized(false);
            }
        } else if (action === 'reset-position') {
            dragController.reset();
        } else if (action === 'stop-queue') {
            queueManager.stop();
        }
    });

    refs.modeButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const nextMode = button.dataset.mode;
            if (queueManager.isActive() && nextMode !== 'queue') {
                queueManager.stop('切换模式，连续阅读已停止');
            }
            setMode(nextMode);
            activateCurrentRoute();
        });
    });

    refs.speedSlider.addEventListener('input', (event) => {
        setSpeed(Number(event.currentTarget.value));
    });

    refs.queueLimit.addEventListener('input', (event) => {
        setQueueLimit(Number(event.currentTarget.value));
    });

    refs.presetButtons.forEach((button) => {
        button.addEventListener('click', () => setSpeed(Number(button.dataset.speed)));
    });

    shadow.querySelectorAll('[data-setting]').forEach((input) => {
        input.addEventListener('change', () => {
            settings[input.dataset.setting] = input.checked;
            StorageManager.save(settings);
        });
    });

    function eventCameFromPanel(event) {
        return event.composedPath().includes(host);
    }

    function pauseForManualInput(event) {
        if (!settings.pauseOnManualInput || !scrollController.isRunning() || eventCameFromPanel(event)) {
            return;
        }

        scrollController.pause('检测到手动操作');
    }

    window.addEventListener('wheel', pauseForManualInput, { capture: true, passive: true });
    window.addEventListener('touchstart', pauseForManualInput, { capture: true, passive: true });

    document.addEventListener('keydown', (event) => {
        if (isEditableTarget(event.target)) {
            return;
        }

        if (event.altKey && event.code === 'KeyS') {
            event.preventDefault();
            handlePrimaryAction();
            return;
        }

        if (event.altKey && event.code === 'KeyM') {
            event.preventDefault();
            setMinimized(!settings.minimized);
            return;
        }

        if (event.altKey && event.code === 'ArrowUp') {
            event.preventDefault();
            setSpeed(settings.speed + CONFIG.speedStep);
            return;
        }

        if (event.altKey && event.code === 'ArrowDown') {
            event.preventDefault();
            setSpeed(settings.speed - CONFIG.speedStep);
            return;
        }

        const manualScrollKeys = new Set(['Space', 'PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp']);
        if (settings.pauseOnManualInput && manualScrollKeys.has(event.code)) {
            scrollController.pause('检测到手动翻页');
        }
    }, true);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && settings.autoPauseOnHidden) {
            scrollController.pause('页面进入后台，已自动暂停');
        } else if (!document.hidden && pendingVisibleAutoStart) {
            pendingVisibleAutoStart = false;
            activateCurrentRoute();
        }
    });

    let scrollUiFrame = null;
    window.addEventListener('scroll', () => {
        if (scrollUiFrame !== null) {
            return;
        }

        scrollUiFrame = requestAnimationFrame(() => {
            scrollController.updateStats();
            scrollUiFrame = null;
        });
    }, { passive: true });

    window.addEventListener('resize', () => {
        dragController.clampToViewport();
        scrollController.updateStats();
    }, { passive: true });

    let lastUrl = window.location.href;
    function handleLocationChange() {
        if (window.location.href === lastUrl) {
            return;
        }

        lastUrl = window.location.href;
        activateCurrentRoute();
        if (isSupportedRoute()) {
            requestAnimationFrame(() => dragController.clampToViewport());
        }
    }

    const routeObserver = new MutationObserver(handleLocationChange);
    routeObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', () => window.setTimeout(handleLocationChange, 0));

    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-color-scheme'] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

    setSpeed(settings.speed, false);
    setQueueLimit(settings.queueLimit, false);
    setMode(settings.mode, false);
    syncTheme();
    activateCurrentRoute();
    requestAnimationFrame(() => dragController.clampToViewport());

    console.info(
        `[${APP.name}] v${APP.version} 已加载。快捷键：Alt+S 开始/暂停，Alt+↑/↓ 调速，Alt+M 最小化。`
    );
})();
