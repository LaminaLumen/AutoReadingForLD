// ==UserScript==
// @name         澜阅
// @name:zh-CN   澜阅 - LINUX DO 沉浸阅读器
// @namespace    https://github.com/LaminaLumen/Lanyue
// @version      2.1.2
// @description  让 LINUX DO 长帖按自然节奏缓缓展开，支持当前帖、自动帖与连续阅读。
// @author       pboy, 澜阅 contributors
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
// @downloadURL  https://raw.githubusercontent.com/LaminaLumen/Lanyue/main/Lanyue.user.js
// @updateURL    https://raw.githubusercontent.com/LaminaLumen/Lanyue/main/Lanyue.user.js
// @homepageURL  https://github.com/LaminaLumen/Lanyue
// @supportURL   https://github.com/LaminaLumen/Lanyue/issues
// ==/UserScript==

(function () {
    'use strict';

    const APP = Object.freeze({
        name: '澜阅',
        version: '2.1.2',
        rootId: 'lanyue-reader-root',
        storageKey: 'lanyue:settings:v1',
        queueStorageKey: 'lanyue:queue:v1',
        recoveryStorageKey: 'lanyue:read-recovery:v1'
    });

    const CONFIG = Object.freeze({
        // 原版最低档为 0.5 px/frame，按常见的 60Hz 刷新率折算约为 30 px/s。
        defaultSpeed: 30,
        settingsRevision: 2,
        minSpeed: 12,
        maxSpeed: 160,
        speedSliderStep: 2,
        speedStep: 4,
        speedVariationMin: 0.88,
        speedVariationMax: 1.12,
        speedVariationIntervalMinMs: 2800,
        speedVariationIntervalMaxMs: 6200,
        bottomThreshold: 120,
        bottomWaitMs: 6000,
        postLoadTimeoutMs: 20000,
        readAheadScanMs: 350,
        readAheadScreens: 4,
        queueCooldownMs: 8000,
        queueMinItems: 1,
        queueMaxItems: 20,
        queueDefaultItems: 10,
        queueSessionMinItems: 10,
        queueSessionMaxItems: 200,
        queueSessionDefaultItems: 100,
        queueRefillThreshold: 2,
        queueRefillMaxLoads: 24,
        queueListLoadWaitMs: 5000,
        queueMaxAgeMs: 24 * 60 * 60 * 1000,
        queueReadBaseMs: 15000,
        queueReadPerPostMs: 3200,
        queueReadMinMs: 30000,
        queueReadMaxMs: 10 * 60 * 1000,
        queuePlanRefreshMs: 1000,
        readStateScanMs: 180,
        readConfirmMinMs: 2800,
        readConfirmMaxMs: 4200,
        readConfirmBandTopRatio: 0.08,
        readConfirmBandBottomRatio: 0.32,
        readConfirmMinVisiblePx: 56,
        readConfirmRetryPulseMs: 1600,
        readConfirmReloadAfterBatches: 2,
        readConfirmFailureWindowMs: 45000,
        bottomReportTimeoutMs: 14000,
        bottomReportQuietMs: 900,
        bottomReportRetryPulseMs: 5000,
        manualPauseGraceMs: 900,
        uiRefreshMs: 120,
        edgePadding: 12,
        snapThreshold: 24
    });

    const SPEED_PRESETS = Object.freeze([
        { key: 'focus', label: '沉浸', speed: 30 },
        { key: 'steady', label: '标准', speed: 52 },
        { key: 'skim', label: '速览', speed: 96 }
    ]);

    const READING_MODES = Object.freeze([
        { key: 'single', label: '当前帖', detail: '手动开始，读到底后停止', icon: 'article' },
        { key: 'auto', label: '自动帖', detail: '手动打开帖子后自动开始', icon: 'playCircle' },
        { key: 'queue', label: '连续读', detail: '从列表建立有上限的阅读队列', icon: 'bookOpenText' }
    ]);

    const STATE_COPY = Object.freeze({
        idle: { chip: '就绪', title: '准备阅读', detail: '选择模式，开始后自动向下滚动' },
        running: { chip: '阅读中', title: '正在向下阅读', detail: '再次点击即可暂停' },
        loading: { chip: '载入', title: '正在衔接后续楼层', detail: '内容就绪后继续阅读' },
        waiting: { chip: '确认中', title: '正在确认阅读记录', detail: '等待站点记录当前楼层' },
        recovering: { chip: '恢复', title: '正在恢复阅读记录', detail: '即将从当前楼层继续' },
        queue: { chip: '队列', title: '连续阅读已就绪', detail: '将在当前标签页逐篇阅读' },
        cooldown: { chip: '间隔', title: '这一篇已读完', detail: '稍后进入下一篇' },
        paused: { chip: '已暂停', title: '停在当前位置', detail: '进度与本次统计已保留' },
        done: { chip: '已完成', title: '已读到末尾', detail: '返回顶部后可以再次开始' }
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

    function formatReadingDuration(milliseconds, roundUpToMinute = false) {
        const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
        if (roundUpToMinute || totalSeconds >= 60) {
            const minutes = Math.max(1, Math.floor(totalSeconds / 60));
            const seconds = totalSeconds % 60;
            return seconds > 0 && !roundUpToMinute
                ? `${minutes} 分 ${seconds} 秒`
                : `${Math.ceil(totalSeconds / 60)} 分钟`;
        }
        return `${totalSeconds} 秒`;
    }

    function parseDisplayedCounts(value) {
        const tokens = String(value || '').match(/\d+(?:[.,]\d+)?\s*(?:[kK万])?/g) || [];
        return tokens
            .map((token) => {
                const suffix = token.match(/[kK万]/)?.[0] || '';
                const numericText = token.replace(/[kK万\s]/g, '');
                if (suffix) {
                    const normalized = Number(numericText.replace(',', '.'));
                    const multiplier = suffix === '万' ? 10000 : 1000;
                    return Math.round(normalized * multiplier);
                }

                return Number(numericText.replace(/\D/g, ''));
            })
            .filter((count) => Number.isFinite(count) && count > 0);
    }

    function displayedCountFromElement(element) {
        if (!(element instanceof Element)) {
            return 0;
        }

        const values = [
            element.textContent,
            element.getAttribute('title'),
            element.getAttribute('aria-label')
        ].flatMap(parseDisplayedCounts);
        return values.length > 0 ? Math.max(...values) : 0;
    }

    const initialPageTopicId = topicIdFromUrl(window.location.href);
    let cachedPreloadedPostCount = null;

    function preloadedTopicPostCount() {
        // 服务端预载数据属于首次打开的话题；站内切帖后继续复用会把上一篇的楼层数带入计划。
        if (!initialPageTopicId || topicIdFromUrl(window.location.href) !== initialPageTopicId) {
            return 0;
        }
        if (cachedPreloadedPostCount !== null) {
            return cachedPreloadedPostCount;
        }

        const element = document.querySelector('#data-preloaded');
        if (!element) {
            return 0;
        }

        const sources = [
            element.getAttribute('data-preloaded'),
            element.textContent
        ].filter((value, index, values) => value && values.indexOf(value) === index);
        let maximum = 0;

        for (const source of sources) {
            // 预载数据可能包含整个话题；设置体积和遍历上限，避免异常页面拖慢滚动。
            if (source.length > 5 * 1024 * 1024) {
                continue;
            }

            let parsed;
            try {
                parsed = JSON.parse(source);
            } catch {
                continue;
            }

            const stack = [parsed];
            const visited = new Set();
            let inspected = 0;
            while (stack.length > 0 && inspected < 2500) {
                const current = stack.pop();
                inspected += 1;

                if (typeof current === 'string') {
                    const trimmed = current.trim();
                    if (trimmed.length <= 5 * 1024 * 1024 && /^(?:\{|\[)/.test(trimmed)) {
                        try {
                            stack.push(JSON.parse(trimmed));
                        } catch {
                            // 部分字段本来就是普通文本，不需要处理。
                        }
                    }
                    continue;
                }

                if (!current || typeof current !== 'object' || visited.has(current)) {
                    continue;
                }
                visited.add(current);

                const stream = current.post_stream?.stream;
                if (Array.isArray(stream)) {
                    maximum = Math.max(maximum, stream.length);
                }

                Object.values(current).forEach((value) => stack.push(value));
            }
        }

        cachedPreloadedPostCount = maximum;
        return maximum;
    }

    function detectTopicPostCount() {
        const candidates = [];
        const pushElementCount = (element, offset = 0) => {
            const count = displayedCountFromElement(element);
            if (count > 0) {
                candidates.push(count + offset);
            }
        };

        document.querySelectorAll('.topic-progress .nums .total').forEach((element) => pushElementCount(element));
        document.querySelectorAll('.topic-progress .nums').forEach((element) => pushElementCount(element));
        document.querySelectorAll('.topic-timeline .timeline-replies .number, .topic-map .replies .number')
            .forEach((element) => pushElementCount(element, 1));

        document.querySelectorAll('.topic-post[data-post-number], [data-post-number]').forEach((element) => {
            const postNumber = Number(element.getAttribute('data-post-number'));
            if (Number.isFinite(postNumber) && postNumber > 0) {
                candidates.push(Math.floor(postNumber));
            }
        });

        const preloadedCount = preloadedTopicPostCount();
        if (preloadedCount > 0) {
            candidates.push(preloadedCount);
        }

        // 正文已经出现时至少按首帖规划，后续探测到更多楼层时只会上调计划。
        return candidates.length > 0 ? Math.max(...candidates) : 1;
    }

    function createQueueReadingPlan() {
        const postCount = detectTopicPostCount();
        return {
            postCount,
            minimumMs: clamp(
                CONFIG.queueReadBaseMs + postCount * CONFIG.queueReadPerPostMs,
                CONFIG.queueReadMinMs,
                CONFIG.queueReadMaxMs
            )
        };
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
                settingsRevision: CONFIG.settingsRevision,
                speed: CONFIG.defaultSpeed,
                mode: 'single',
                queueLimit: CONFIG.queueDefaultItems,
                queueSessionLimit: CONFIG.queueSessionDefaultItems,
                minimized: true,
                autoPauseOnHidden: false,
                pauseOnManualInput: false,
                position: null
            };
        },

        normalize(value) {
            const defaults = this.defaults();
            const migrateDefaultQueueSize = Number(value?.settingsRevision) < 2
                && Number(value?.queueLimit) === 8;
            const rawPosition = value?.position;
            const position = rawPosition
                && isFiniteNumber(rawPosition.left)
                && isFiniteNumber(rawPosition.top)
                ? { left: rawPosition.left, top: rawPosition.top }
                : null;

            return {
                settingsRevision: CONFIG.settingsRevision,
                speed: clamp(
                    isFiniteNumber(value?.speed) ? value.speed : defaults.speed,
                    CONFIG.minSpeed,
                    CONFIG.maxSpeed
                ),
                mode: READING_MODES.some((mode) => mode.key === value?.mode) ? value.mode : defaults.mode,
                queueLimit: clamp(
                    migrateDefaultQueueSize
                        ? defaults.queueLimit
                        : Number.isFinite(Number(value?.queueLimit))
                            ? Math.round(Number(value.queueLimit))
                            : defaults.queueLimit,
                    CONFIG.queueMinItems,
                    CONFIG.queueMaxItems
                ),
                queueSessionLimit: clamp(
                    Number.isFinite(Number(value?.queueSessionLimit))
                        ? Math.round(Number(value.queueSessionLimit) / 10) * 10
                        : defaults.queueSessionLimit,
                    CONFIG.queueSessionMinItems,
                    CONFIG.queueSessionMaxItems
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

        load() {
            try {
                const savedText = localStorage.getItem(APP.storageKey);
                if (savedText) {
                    const saved = JSON.parse(savedText);
                    const normalized = this.normalize(saved);
                    if (saved?.settingsRevision !== CONFIG.settingsRevision) {
                        this.save(normalized);
                    }

                    return normalized;
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
        checkCircle: '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm45.66-117.66a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34Z"/>',
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
                --page-surface: #ffffff;
                --page-ink: #222222;
                --page-muted: #6f7478;
                --page-line: #e2e5e7;
                --page-accent: #168bd2;
                --surface: color-mix(in srgb, var(--page-surface) 96%, var(--page-ink));
                --surface-raised: color-mix(in srgb, var(--page-surface) 99%, var(--page-ink));
                --rail: color-mix(in srgb, var(--page-surface) 94%, var(--page-ink));
                --rail-selected: color-mix(in srgb, var(--page-surface) 89%, var(--page-accent));
                --ink: var(--page-ink);
                --muted: var(--page-muted);
                --faint: color-mix(in srgb, var(--page-muted) 72%, var(--page-surface));
                --line: var(--page-line);
                --line-strong: color-mix(in srgb, var(--page-line) 72%, var(--page-ink));
                --forest: var(--page-accent);
                --forest-deep: color-mix(in srgb, var(--page-accent) 76%, var(--page-ink));
                --forest-soft: color-mix(in srgb, var(--page-surface) 88%, var(--page-accent));
                --action: var(--page-accent);
                --action-hover: color-mix(in srgb, var(--page-accent) 84%, var(--page-ink));
                --terracotta: var(--page-accent);
                --terracotta-soft: color-mix(in srgb, var(--page-surface) 86%, var(--page-accent));
                --danger: #b6534b;
                --success: #438765;
                --warning: #b57632;
                --shadow: 0 18px 44px color-mix(in srgb, var(--page-ink) 15%, transparent), 0 3px 10px color-mix(in srgb, var(--page-ink) 8%, transparent);
                color: var(--ink);
                color-scheme: light;
                font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                font-size: 14px;
                line-height: 1.45;
                -webkit-font-smoothing: antialiased;
                text-rendering: optimizeLegibility;
            }

            :host([data-theme="dark"]) {
                --page-surface: #1e2124;
                --page-ink: #e9ecef;
                --page-muted: #a3a9ae;
                --page-line: #373c40;
                --page-accent: #49a9df;
                --danger: #e39a91;
                --success: #70b58d;
                --warning: #d6a15e;
                --shadow: 0 22px 52px rgba(0, 0, 0, 0.42), 0 3px 12px rgba(0, 0, 0, 0.25);
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
                --state-color: var(--muted);
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
                border-radius: 16px;
                background:
                    linear-gradient(145deg, color-mix(in srgb, var(--page-accent) 4%, transparent), transparent 34%),
                    var(--surface-raised);
                box-shadow: var(--shadow);
                transform-origin: var(--panel-origin-x, 100%) var(--panel-origin-y, 0%);
                animation: panel-in 180ms ease-out both;
            }

            .mode-rail {
                display: flex;
                min-height: 412px;
                flex-direction: column;
                border-right: 1px solid var(--line);
                background:
                    linear-gradient(180deg, color-mix(in srgb, var(--page-accent) 4%, transparent), transparent 30%),
                    var(--rail);
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
                width: 30px;
                height: 30px;
                padding: 5px;
                border: 1px solid transparent;
                border-radius: 9px;
                background: color-mix(in srgb, var(--surface-raised) 54%, transparent);
                color: var(--faint);
                font-size: 18px;
                transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease;
            }

            .mode-button:hover .mode-icon {
                border-color: var(--line);
                background: var(--surface-raised);
                color: var(--forest);
            }

            .mode-button[aria-pressed="true"] .mode-icon {
                border-color: color-mix(in srgb, var(--terracotta) 24%, var(--line));
                background: color-mix(in srgb, var(--terracotta-soft) 72%, var(--surface-raised));
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
                min-height: 60px;
                flex: 0 0 auto;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 8px 11px 8px 13px;
                border-bottom: 1px solid var(--line);
                cursor: grab;
                touch-action: none;
            }

            .brand {
                display: flex;
                min-width: 0;
                align-items: center;
                gap: 9px;
            }

            .brand__mark {
                position: relative;
                display: grid;
                width: 32px;
                height: 32px;
                flex: 0 0 auto;
                place-items: center;
                overflow: hidden;
                border: 1px solid color-mix(in srgb, var(--page-accent) 24%, var(--line));
                border-radius: 10px;
                background: color-mix(in srgb, var(--page-accent) 9%, var(--surface-raised));
                color: var(--forest-deep);
                box-shadow: inset 0 1px 0 color-mix(in srgb, var(--page-surface) 70%, transparent);
            }

            .brand__mark::after {
                position: absolute;
                right: -9px;
                bottom: -10px;
                width: 24px;
                height: 24px;
                border: 1px solid color-mix(in srgb, var(--page-accent) 14%, transparent);
                border-radius: 50%;
                content: "";
            }

            .brand__mark .icon {
                position: relative;
                z-index: 1;
                font-size: 17px;
            }

            .brand__copy {
                display: grid;
                min-width: 0;
                gap: 1px;
            }

            .brand__name {
                overflow: hidden;
                color: var(--ink);
                font-family: "Songti SC", STSong, "Noto Serif SC", "Source Han Serif SC", serif;
                font-size: 18px;
                font-weight: 700;
                line-height: 1.2;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .brand__meta {
                color: var(--faint);
                font-size: 9.5px;
                font-weight: 620;
                letter-spacing: 0.04em;
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
                position: relative;
                display: grid;
                gap: 6px;
            }

            .state-line {
                display: flex;
                align-items: center;
                gap: 7px;
                color: var(--state-color);
                font-size: 12px;
                font-weight: 700;
                transition: color 160ms ease;
            }

            .state-dot {
                width: 7px;
                height: 7px;
                flex: 0 0 auto;
                border-radius: 50%;
                background: var(--state-color);
                box-shadow: 0 0 0 3px color-mix(in srgb, var(--state-color) 16%, transparent);
                transition: background 160ms ease, box-shadow 160ms ease;
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
                position: relative;
                display: flex;
                width: 100%;
                min-height: 41px;
                align-items: center;
                justify-content: center;
                gap: 8px;
                margin-top: 5px;
                padding: 10px 14px;
                border: 1px solid var(--action);
                border-radius: 10px;
                background: var(--action);
                color: var(--page-surface);
                box-shadow: 0 5px 12px color-mix(in srgb, var(--action) 18%, transparent);
                font-size: 14.5px;
                font-weight: 720;
                letter-spacing: 0.02em;
                overflow: hidden;
                cursor: pointer;
                transition: background 140ms ease, transform 140ms ease, box-shadow 140ms ease;
            }

            .main-control::after {
                position: absolute;
                inset: 0;
                background: linear-gradient(105deg, transparent 25%, color-mix(in srgb, var(--page-surface) 28%, transparent) 48%, transparent 72%);
                content: "";
                opacity: 0;
                pointer-events: none;
                transform: translateX(-105%);
            }

            .shell[data-state="running"] .main-control::after {
                opacity: 0.42;
                animation: reading-flow 3.2s ease-in-out infinite;
            }

            .control-icon {
                font-size: 16px;
            }

            .main-control:hover {
                background: var(--action-hover);
                box-shadow: 0 6px 15px color-mix(in srgb, var(--action) 24%, transparent);
            }

            .main-control:active {
                transform: translateY(1px);
            }

            .main-control:disabled,
            .dock__control:disabled {
                cursor: wait;
                opacity: 0.78;
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
                grid-template-columns: minmax(0, 1fr) 31px;
                width: 148px;
                height: 48px;
                align-items: center;
                padding: 3px;
                overflow: hidden;
                border: 1px solid color-mix(in srgb, var(--line-strong) 86%, var(--state-color));
                border-radius: 999px;
                background: color-mix(in srgb, var(--surface-raised) 91%, transparent);
                color: var(--ink);
                box-shadow:
                    0 14px 32px color-mix(in srgb, var(--page-ink) 15%, transparent),
                    0 2px 8px color-mix(in srgb, var(--page-ink) 8%, transparent),
                    inset 0 1px 0 color-mix(in srgb, var(--page-surface) 76%, transparent);
                isolation: isolate;
                touch-action: none;
                backdrop-filter: blur(18px) saturate(1.12);
                -webkit-backdrop-filter: blur(18px) saturate(1.12);
                transition: border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
            }

            .dock::before {
                position: absolute;
                z-index: 0;
                inset: 0;
                border-radius: inherit;
                background:
                    radial-gradient(circle at 17% 0%, color-mix(in srgb, var(--state-color) 13%, transparent), transparent 42%),
                    linear-gradient(112deg, color-mix(in srgb, var(--surface-raised) 82%, transparent), color-mix(in srgb, var(--surface-raised) 96%, transparent) 54%, color-mix(in srgb, var(--page-accent) 7%, var(--surface-raised)));
                content: "";
                pointer-events: none;
            }

            .dock::after {
                position: absolute;
                z-index: 4;
                inset: 0;
                border: 1px solid color-mix(in srgb, var(--page-surface) 54%, transparent);
                border-radius: inherit;
                box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--page-ink) 6%, transparent);
                content: "";
                pointer-events: none;
            }

            .dock__fluid {
                position: absolute;
                z-index: 1;
                inset: 0;
                width: 100%;
                height: 100%;
                opacity: 0.44;
                pointer-events: none;
                filter: saturate(1.12) contrast(1.04);
                transform: translateZ(0);
                transition: opacity 320ms ease, filter 320ms ease;
            }

            .dock:hover {
                border-color: color-mix(in srgb, var(--state-color) 52%, var(--line-strong));
                box-shadow:
                    0 18px 38px color-mix(in srgb, var(--page-ink) 18%, transparent),
                    0 3px 10px color-mix(in srgb, var(--page-ink) 9%, transparent),
                    inset 0 1px 0 color-mix(in srgb, var(--page-surface) 82%, transparent);
                transform: translateY(-1px);
            }

            .dock:active {
                transform: translateY(0);
            }

            .dock__control,
            .dock__expand {
                position: relative;
                z-index: 2;
                min-width: 0;
                border: 0;
                background: transparent;
                color: inherit;
                cursor: pointer;
            }

            .dock__control {
                display: grid;
                grid-template-columns: 36px minmax(0, 1fr);
                height: 40px;
                align-items: center;
                gap: 8px;
                padding: 2px 5px 2px 1px;
                border-radius: 999px 9px 9px 999px;
                text-align: left;
                touch-action: none;
                transition: background 160ms ease;
            }

            .dock__control:hover {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--state-color) 7%, transparent),
                    color-mix(in srgb, var(--state-color) 4%, transparent) 62%,
                    transparent 100%
                );
            }

            .dock__control:active {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--state-color) 11%, transparent),
                    color-mix(in srgb, var(--state-color) 6%, transparent) 58%,
                    transparent 100%
                );
            }

            .dock__expand {
                display: grid;
                width: 31px;
                height: 34px;
                place-items: center;
                border-left: 1px solid color-mix(in srgb, var(--line) 88%, transparent);
                border-radius: 4px 999px 999px 4px;
                color: var(--muted);
                transition: color 160ms ease, background 160ms ease;
            }

            .dock__expand .icon {
                width: 14px;
                height: 14px;
            }

            .dock__expand:hover {
                background: color-mix(in srgb, var(--state-color) 9%, transparent);
                color: var(--state-color);
            }

            .dock__glyph {
                position: relative;
                display: grid;
                width: 36px;
                height: 36px;
                place-items: center;
                border-radius: 50%;
                background: conic-gradient(
                    var(--state-color) 0 var(--progress, 0deg),
                    color-mix(in srgb, var(--line) 82%, transparent) var(--progress, 0deg) 1turn
                );
                color: var(--state-color);
                box-shadow: 0 2px 9px color-mix(in srgb, var(--page-ink) 7%, transparent);
                transition: color 220ms ease, box-shadow 220ms ease;
            }

            .dock__glyph::before {
                position: absolute;
                width: 30px;
                height: 30px;
                border-radius: 50%;
                background: color-mix(in srgb, var(--surface-raised) 90%, transparent);
                box-shadow:
                    inset 0 0 0 1px color-mix(in srgb, var(--line) 72%, transparent),
                    inset 0 1px 0 color-mix(in srgb, var(--page-surface) 70%, transparent);
                backdrop-filter: blur(6px);
                content: "";
            }

            .dock__state-icon,
            .dock__spinner {
                position: relative;
                z-index: 1;
                display: none;
                grid-area: 1 / 1;
            }

            .dock__state-icon {
                width: 17px;
                height: 17px;
            }

            .dock__spinner {
                width: 16px;
                height: 16px;
                border: 1.5px solid color-mix(in srgb, var(--state-color) 24%, transparent);
                border-top-color: var(--state-color);
                border-radius: 50%;
                animation: spin 850ms linear infinite;
            }

            .dock__copy {
                position: relative;
                display: grid;
                min-width: 0;
                gap: 2px;
                text-align: left;
            }

            .dock__copy strong,
            .dock__copy small {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .dock__copy strong {
                color: var(--state-color);
                font-size: 12px;
                font-weight: 740;
                line-height: 1.15;
                letter-spacing: 0.01em;
            }

            .dock__copy small {
                color: var(--muted);
                font-size: 9.25px;
                font-weight: 560;
                line-height: 1.2;
            }

            .shell[data-minimized="true"] .panel {
                display: none;
            }

            .shell[data-minimized="true"] {
                width: 148px;
            }

            .shell[data-minimized="true"] .dock {
                display: grid;
                animation: panel-in 160ms ease-out both;
            }

            .shell[data-state="running"],
            .shell[data-state="queue"] {
                --state-color: var(--forest);
            }

            .shell[data-state="loading"],
            .shell[data-state="waiting"],
            .shell[data-state="recovering"],
            .shell[data-state="cooldown"],
            .shell[data-state="paused"] {
                --state-color: var(--warning);
            }

            .shell[data-state="done"] {
                --state-color: var(--success);
            }

            .shell[data-state="idle"] [data-dock-icon="idle"],
            .shell[data-state="running"] [data-dock-icon="running"],
            .shell[data-state="queue"] [data-dock-icon="queue"],
            .shell[data-state="paused"] [data-dock-icon="paused"],
            .shell[data-state="done"] [data-dock-icon="done"],
            .shell[data-state="loading"] [data-dock-icon="busy"],
            .shell[data-state="waiting"] [data-dock-icon="busy"],
            .shell[data-state="recovering"] [data-dock-icon="busy"],
            .shell[data-state="cooldown"] [data-dock-icon="busy"] {
                display: block;
            }

            .shell[data-state="running"] .state-dot {
                animation: breathe 1.8s ease-in-out infinite;
            }

            .shell[data-state="running"] .dock__glyph {
                animation: dock-pulse 2.2s ease-in-out infinite;
            }

            .shell[data-state="running"] .dock__fluid,
            .shell[data-state="loading"] .dock__fluid,
            .shell[data-state="waiting"] .dock__fluid,
            .shell[data-state="recovering"] .dock__fluid,
            .shell[data-state="queue"] .dock__fluid,
            .shell[data-state="cooldown"] .dock__fluid {
                opacity: 0.94;
                filter: saturate(1.24) contrast(1.06);
            }

            .shell[data-state="paused"] .dock__fluid {
                opacity: 0.28;
            }

            .shell[data-state="done"] .dock__fluid {
                opacity: 0.58;
            }

            .shell[data-state="running"] .dock,
            .shell[data-state="queue"] .dock {
                border-color: color-mix(in srgb, var(--state-color) 42%, var(--line-strong));
                box-shadow:
                    0 16px 38px color-mix(in srgb, var(--page-ink) 17%, transparent),
                    0 3px 10px color-mix(in srgb, var(--page-ink) 8%, transparent),
                    0 0 20px color-mix(in srgb, var(--state-color) 9%, transparent),
                    inset 0 1px 0 color-mix(in srgb, var(--page-surface) 82%, transparent);
            }

            :host([data-dock-fx="fallback"]) .shell[data-state="running"] .dock::before,
            :host([data-dock-fx="fallback"]) .shell[data-state="loading"] .dock::before,
            :host([data-dock-fx="fallback"]) .shell[data-state="waiting"] .dock::before,
            :host([data-dock-fx="fallback"]) .shell[data-state="recovering"] .dock::before {
                background:
                    radial-gradient(circle at 18% 18%, color-mix(in srgb, var(--state-color) 24%, transparent), transparent 35%),
                    radial-gradient(circle at 72% 80%, color-mix(in srgb, var(--page-accent) 15%, transparent), transparent 44%),
                    linear-gradient(112deg, color-mix(in srgb, var(--surface-raised) 78%, transparent), color-mix(in srgb, var(--state-color) 14%, var(--surface-raised)) 54%, var(--surface-raised));
                background-size: 145% 145%, 165% 165%, 100% 100%;
                animation: dock-fallback-flow 3.2s ease-in-out infinite alternate;
            }

            :host([data-dragging="true"]) .panel,
            :host([data-dragging="true"]) .dock {
                box-shadow: 0 24px 56px rgba(33, 43, 36, 0.22), 0 5px 14px rgba(33, 43, 36, 0.12);
            }

            :host([data-dragging="true"]) .dock__control {
                cursor: grabbing;
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

            @keyframes dock-pulse {
                0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--state-color) 0%, transparent); }
                50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--state-color) 10%, transparent); }
            }

            @keyframes dock-fallback-flow {
                from { background-position: 0% 50%; }
                to { background-position: 100% 50%; }
            }

            @keyframes reading-flow {
                0%, 18% { transform: translateX(-105%); }
                58%, 100% { transform: translateX(105%); }
            }

            @keyframes spin {
                to { transform: rotate(1turn); }
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
            <section class="panel" aria-label="澜阅阅读控制台">
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
                            <span class="brand__mark" aria-hidden="true">${renderIcon('waveSine')}</span>
                            <span class="brand__copy">
                                <span class="brand__name">澜阅</span>
                                <span class="brand__meta">LINUX DO · 长帖阅读器</span>
                            </span>
                        </div>
                        <button class="minimize-button" type="button" data-action="minimize" aria-label="收起阅读控制台" title="收起（Alt + M）">
                            ${renderIcon('minus')}
                        </button>
                    </header>

                    <main class="panel__body">
                        <section class="hero" aria-labelledby="reading-state-title">
                            <div class="state-line" role="status" aria-live="polite">
                                <span class="state-dot" aria-hidden="true"></span>
                                <span data-role="state-chip">就绪</span>
                            </div>
                            <strong class="hero__title" id="reading-state-title" data-role="state-title">准备阅读</strong>
                            <span class="hero__detail" data-role="state-detail">选择模式，开始后自动向下滚动</span>
                            <div class="queue-summary" data-role="queue-summary" hidden>
                                <strong>保持 <span data-role="queue-summary-count">${settings.queueLimit}</span> 篇</strong>
                                <span>· 本轮最多 <span data-role="queue-summary-limit">${settings.queueSessionLimit}</span> 篇</span>
                            </div>
                            <button class="main-control" type="button" data-action="toggle" aria-label="开始阅读">
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
                                step="${CONFIG.speedSliderStep}"
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
                                        <span>队列容量</span>
                                        <input
                                            class="queue-limit"
                                            data-role="queue-limit"
                                            type="range"
                                            min="${CONFIG.queueMinItems}"
                                            max="${CONFIG.queueMaxItems}"
                                            step="1"
                                            value="${settings.queueLimit}"
                                            aria-label="连续阅读队列容量"
                                        >
                                        <strong class="queue-count" data-role="queue-count">${settings.queueLimit} 篇</strong>
                                    </div>
                                    <div class="queue-control-row">
                                        <span>本轮上限</span>
                                        <input
                                            class="queue-limit"
                                            data-role="queue-session-limit"
                                            type="range"
                                            min="${CONFIG.queueSessionMinItems}"
                                            max="${CONFIG.queueSessionMaxItems}"
                                            step="10"
                                            value="${settings.queueSessionLimit}"
                                            aria-label="本轮连续阅读总篇数上限"
                                        >
                                        <strong class="queue-count" data-role="queue-session-count">${settings.queueSessionLimit} 篇</strong>
                                    </div>
                                    <div class="queue-note">
                                        <span data-role="queue-note">读完自动补队列 · 前台间隔</span>
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
                                <small>按需开启</small>
                                ${renderIcon('caretDown', 'icon fold-caret')}
                            </summary>
                            <div class="preferences">
                                <label class="preference">
                                    <span class="preference__copy">
                                        <span class="preference__title">切到后台时暂停</span>
                                        <span class="preference__detail">返回当前页面后自动继续</span>
                                    </span>
                                    <input type="checkbox" data-setting="autoPauseOnHidden" ${settings.autoPauseOnHidden ? 'checked' : ''}>
                                </label>

                                <label class="preference">
                                    <span class="preference__copy">
                                        <span class="preference__title">手动操作时暂停</span>
                                        <span class="preference__detail">滚轮、触摸或翻页键接管页面</span>
                                    </span>
                                    <input type="checkbox" data-setting="pauseOnManualInput" ${settings.pauseOnManualInput ? 'checked' : ''}>
                                </label>
                            </div>
                        </details>
                    </main>

                    <footer class="panel__footer">
                        <span class="footer-note" title="澜阅 ${APP.version}">${renderIcon('waveSine')}自然变速 ±12%</span>
                        <button class="reset-button" type="button" data-action="reset-position" title="恢复默认位置">
                            ${renderIcon('arrowCounterClockwise')}
                            <span>复位位置</span>
                        </button>
                    </footer>
                </div>
            </section>

            <div class="dock" role="group" aria-label="澜阅快捷控制">
                <canvas class="dock__fluid" data-role="dock-fluid" aria-hidden="true"></canvas>
                <button class="dock__control" type="button" data-action="dock-toggle" data-drag-handle aria-label="开始阅读" title="点按开始 · 拖动可移动">
                    <span class="dock__glyph" aria-hidden="true">
                        ${renderIcon('play', 'icon dock__state-icon', 'data-dock-icon="idle"')}
                        ${renderIcon('waveSine', 'icon dock__state-icon', 'data-dock-icon="running"')}
                        ${renderIcon('bookOpenText', 'icon dock__state-icon', 'data-dock-icon="queue"')}
                        ${renderIcon('pause', 'icon dock__state-icon', 'data-dock-icon="paused"')}
                        ${renderIcon('checkCircle', 'icon dock__state-icon', 'data-dock-icon="done"')}
                        <span class="dock__spinner" data-dock-icon="busy"></span>
                    </span>
                    <span class="dock__copy">
                        <strong data-role="dock-state-label">就绪</strong>
                        <small data-role="dock-state-detail">点按开始</small>
                    </span>
                </button>
                <button class="dock__expand" type="button" data-action="expand" aria-label="展开阅读设置" title="展开阅读设置">
                    ${renderIcon('slidersHorizontal')}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(host);

    const refs = {
        shell: shadow.querySelector('.shell'),
        panel: shadow.querySelector('.panel'),
        dock: shadow.querySelector('.dock'),
        dockControl: shadow.querySelector('.dock__control'),
        dockExpand: shadow.querySelector('.dock__expand'),
        dockFluid: shadow.querySelector('[data-role="dock-fluid"]'),
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
        queueSummaryLimit: shadow.querySelector('[data-role="queue-summary-limit"]'),
        queueOptions: shadow.querySelector('[data-role="queue-options"]'),
        queueLimit: shadow.querySelector('[data-role="queue-limit"]'),
        queueCount: shadow.querySelector('[data-role="queue-count"]'),
        queueSessionLimit: shadow.querySelector('[data-role="queue-session-limit"]'),
        queueSessionCount: shadow.querySelector('[data-role="queue-session-count"]'),
        queueNote: shadow.querySelector('[data-role="queue-note"]'),
        queueStop: shadow.querySelector('[data-role="queue-stop"]'),
        progressValue: shadow.querySelector('[data-role="progress-value"]'),
        timeValue: shadow.querySelector('[data-role="time-value"]'),
        distanceValue: shadow.querySelector('[data-role="distance-value"]'),
        dockStateLabel: shadow.querySelector('[data-role="dock-state-label"]'),
        dockStateDetail: shadow.querySelector('[data-role="dock-state-detail"]'),
        presetButtons: [...shadow.querySelectorAll('[data-speed]')]
    };

    const themeColorProbe = document.createElement('span');
    themeColorProbe.setAttribute('aria-hidden', 'true');
    themeColorProbe.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;';
    shadow.appendChild(themeColorProbe);
    const themeColorCanvas = document.createElement('canvas');
    themeColorCanvas.width = 1;
    themeColorCanvas.height = 1;
    const themeColorContext = themeColorCanvas.getContext('2d', { willReadFrequently: true });

    function resolveCssColor(value) {
        const candidate = String(value || '').trim();
        if (!candidate) {
            return null;
        }

        themeColorProbe.style.color = '';
        themeColorProbe.style.color = candidate;
        if (!themeColorProbe.style.color) {
            return null;
        }

        const resolved = getComputedStyle(themeColorProbe).color;
        let [red, green, blue, alpha = 1] = resolved.match(/[\d.]+/g)?.map(Number) || [];

        // Canvas 将 color(srgb)、display-p3、lab 等现代色彩语法统一转换成可比较的 RGBA。
        if (themeColorContext) {
            themeColorContext.clearRect(0, 0, 1, 1);
            themeColorContext.fillStyle = resolved;
            themeColorContext.fillRect(0, 0, 1, 1);
            const pixel = themeColorContext.getImageData(0, 0, 1, 1).data;
            [red, green, blue, alpha] = [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
        }

        if (![red, green, blue, alpha].every(Number.isFinite)) {
            return null;
        }

        return {
            css: resolved,
            red,
            green,
            blue,
            alpha,
            luminance: (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
        };
    }

    function readPageColorToken(...tokens) {
        const styles = [getComputedStyle(document.body), getComputedStyle(document.documentElement)];
        for (const token of tokens) {
            for (const style of styles) {
                const color = resolveCssColor(style.getPropertyValue(token));
                if (color && color.alpha > 0.05) {
                    return color;
                }
            }
        }
        return null;
    }

    function readVisiblePageBackground() {
        const candidates = [
            document.querySelector('#main-outlet'),
            document.querySelector('.background-container'),
            document.body,
            document.documentElement
        ];

        for (const element of candidates) {
            if (!element) {
                continue;
            }

            const color = resolveCssColor(getComputedStyle(element).backgroundColor);
            // transparent 在浏览器中通常会计算为 rgba(0, 0, 0, 0)，不能据此判为暗色。
            if (color && color.alpha > 0.05) {
                return color;
            }
        }

        return null;
    }

    let dockFluidEffect = null;

    function syncTheme() {
        // 优先使用 Discourse 主题令牌；站点自定义主题也能同步背景、文字、边线与强调色。
        const background = readPageColorToken('--secondary', '--d-content-background', '--surface', '--page')
            || readVisiblePageBackground();
        const foreground = readPageColorToken('--primary', '--primary-very-high', '--ink')
            || resolveCssColor(getComputedStyle(document.body).color);
        const muted = readPageColorToken('--primary-medium', '--primary-high', '--muted');
        const line = readPageColorToken('--primary-low', '--primary-low-mid', '--line');
        const accent = readPageColorToken('--tertiary', '--d-link-color', '--accent');

        const themeHints = [
            document.documentElement.className,
            document.body.className,
            document.documentElement.dataset.colorScheme,
            document.documentElement.dataset.theme,
            document.body.dataset.colorScheme,
            document.body.dataset.theme,
            getComputedStyle(document.documentElement).colorScheme
        ].filter(Boolean).join(' ').toLowerCase();
        const explicitlyDark = /(?:^|[\s_-])dark(?:$|[\s_-])/.test(themeHints);
        const explicitlyLight = /(?:^|[\s_-])light(?:$|[\s_-])/.test(themeHints);
        const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
        const dark = background
            ? background.luminance < 0.48
            : explicitlyDark || (!explicitlyLight && prefersDark);

        host.dataset.theme = dark ? 'dark' : 'light';

        const applyThemeColor = (property, color) => {
            if (color) {
                host.style.setProperty(property, color.css);
            } else {
                host.style.removeProperty(property);
            }
        };

        applyThemeColor('--page-surface', background);
        applyThemeColor('--page-ink', foreground);
        applyThemeColor('--page-muted', muted);
        applyThemeColor('--page-line', line);
        applyThemeColor('--page-accent', accent);
        dockFluidEffect?.syncTheme();
    }

    function createDockFluidEffect() {
        const canvas = refs.dockFluid;
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        const animatedStates = new Set(['running', 'loading', 'waiting', 'recovering', 'queue', 'cooldown']);
        const fallback = {
            setState() {},
            setProgress() {},
            setMinimized() {},
            syncTheme() {}
        };

        if (!canvas) {
            host.dataset.dockFx = 'fallback';
            return fallback;
        }

        const gl = canvas.getContext('webgl', {
            alpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'low-power',
            premultipliedAlpha: true,
            preserveDrawingBuffer: false
        });

        if (!gl) {
            host.dataset.dockFx = 'fallback';
            return fallback;
        }

        const vertexSource = `
            attribute vec2 a_position;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;
        const fragmentSource = `
            precision mediump float;
            uniform vec2 u_resolution;
            uniform float u_time;
            uniform float u_activity;
            uniform float u_progress;
            uniform float u_dark;
            uniform float u_hover;
            uniform vec2 u_pointer;
            uniform vec3 u_accent;
            uniform vec3 u_state;
            uniform vec3 u_surface;

            float hash21(vec2 point) {
                point = fract(point * vec2(123.34, 456.21));
                point += dot(point, point + 45.32);
                return fract(point.x * point.y);
            }

            float noise21(vec2 point) {
                vec2 cell = floor(point);
                vec2 local = fract(point);
                local = local * local * (3.0 - 2.0 * local);

                float bottomLeft = hash21(cell);
                float bottomRight = hash21(cell + vec2(1.0, 0.0));
                float topLeft = hash21(cell + vec2(0.0, 1.0));
                float topRight = hash21(cell + vec2(1.0, 1.0));
                return mix(
                    mix(bottomLeft, bottomRight, local.x),
                    mix(topLeft, topRight, local.x),
                    local.y
                );
            }

            float fbm(vec2 point) {
                float value = 0.0;
                float amplitude = 0.52;
                mat2 turn = mat2(0.86, -0.51, 0.51, 0.86);
                for (int octave = 0; octave < 4; octave++) {
                    value += amplitude * noise21(point);
                    point = turn * point * 2.03 + vec2(7.1, 11.7);
                    amplitude *= 0.49;
                }
                return value;
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / u_resolution.xy;
                float aspect = u_resolution.x / max(u_resolution.y, 1.0);
                vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
                float time = u_time * mix(0.18, 0.42, u_activity);

                // 两层域扭曲让水纹拥有真实折射感，同时保持小画布上的清晰轮廓。
                float firstField = fbm(p * 1.55 + vec2(time * 0.23, -time * 0.14));
                float secondField = fbm(
                    p * 2.18
                    + vec2(-time * 0.18, time * 0.21)
                    + vec2(firstField * 0.9, -firstField * 0.62)
                );
                vec2 warped = p + vec2(firstField - 0.5, secondField - 0.5) * 0.34;

                float primaryCenter = 0.035
                    + 0.11 * sin(warped.x * 2.7 - time * 1.48)
                    + 0.035 * sin(warped.x * 7.6 + time * 0.72);
                float secondaryCenter = -0.235
                    + 0.064 * sin(warped.x * 4.4 + time * 0.94 + secondField * 2.4);
                float primaryRibbon = exp(-10.5 * abs(warped.y - primaryCenter));
                float secondaryRibbon = exp(-17.0 * abs(warped.y - secondaryCenter));

                float causticPhase = warped.x * 9.8
                    + warped.y * 13.5
                    + (firstField - secondField) * 8.2
                    - time * 3.1;
                float caustic = pow(max(0.0, 1.0 - abs(sin(causticPhase))), 8.0)
                    * (primaryRibbon + secondaryRibbon * 0.58);
                float facets = smoothstep(
                    0.78,
                    0.98,
                    noise21(warped * 12.0 + vec2(time * 0.72, -time * 0.46))
                ) * primaryRibbon;

                vec2 pointerPosition = (u_pointer - 0.5) * vec2(aspect, 1.0);
                float pointerDistance = length(p - pointerPosition);
                float pointerLens = exp(-7.5 * pointerDistance) * u_hover;
                float pointerRim = exp(-52.0 * abs(pointerDistance - 0.19)) * u_hover;

                float progressHead = exp(-58.0 * abs(uv.x - u_progress))
                    * exp(-18.0 * abs(uv.y - 0.09));
                float progressTrail = (1.0 - smoothstep(u_progress - 0.28, u_progress, uv.x))
                    * exp(-22.0 * abs(uv.y - 0.085));
                float progressWake = progressHead + progressTrail * 0.28;
                float edgeFade = smoothstep(0.0, 0.08, uv.x)
                    * smoothstep(0.0, 0.08, 1.0 - uv.x)
                    * smoothstep(0.0, 0.12, uv.y)
                    * smoothstep(0.0, 0.12, 1.0 - uv.y);

                float colorField = clamp(0.26 + firstField * 0.46 + caustic * 0.22, 0.0, 1.0);
                vec3 deepGlass = mix(u_accent, u_state, colorField);
                vec3 fluid = mix(u_surface, deepGlass, 0.48 + primaryRibbon * 0.24);
                vec3 pearl = mix(deepGlass, vec3(1.0), mix(0.1, 0.34, u_dark));
                float specular = clamp(
                    caustic * 0.7
                    + facets * 0.42
                    + pointerRim * 0.36
                    + progressHead * 0.32,
                    0.0,
                    1.0
                );
                fluid = mix(fluid, pearl, specular);

                float energy = primaryRibbon * 0.45
                    + secondaryRibbon * 0.2
                    + caustic * 0.52
                    + facets * 0.18
                    + pointerLens * 0.16
                    + pointerRim * 0.18
                    + progressWake * (0.12 + 0.13 * u_activity);
                float alpha = edgeFade
                    * (mix(0.028, 0.052, u_dark) + energy * mix(0.18, 0.36, u_activity))
                    * mix(0.92, 1.12, u_dark);

                gl_FragColor = vec4(fluid, clamp(alpha, 0.0, 0.58));
            }
        `;

        function compileShader(type, source) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        }

        const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
        if (!vertexShader || !fragmentShader) {
            host.dataset.dockFx = 'fallback';
            return fallback;
        }

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            gl.deleteProgram(program);
            host.dataset.dockFx = 'fallback';
            return fallback;
        }

        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
            gl.STATIC_DRAW
        );
        gl.useProgram(program);
        const positionLocation = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        const uniforms = {
            resolution: gl.getUniformLocation(program, 'u_resolution'),
            time: gl.getUniformLocation(program, 'u_time'),
            activity: gl.getUniformLocation(program, 'u_activity'),
            progress: gl.getUniformLocation(program, 'u_progress'),
            dark: gl.getUniformLocation(program, 'u_dark'),
            hover: gl.getUniformLocation(program, 'u_hover'),
            pointer: gl.getUniformLocation(program, 'u_pointer'),
            accent: gl.getUniformLocation(program, 'u_accent'),
            state: gl.getUniformLocation(program, 'u_state'),
            surface: gl.getUniformLocation(program, 'u_surface')
        };

        let state = refs.shell.dataset.state || 'idle';
        let progress = 0;
        let frameId = null;
        let lastDrawAt = 0;
        let hovered = false;
        let contextLost = false;
        let paletteDirty = true;
        let pointer = { x: 0.5, y: 0.5 };
        let pointerTarget = { x: 0.5, y: 0.5 };
        let palette = {
            accent: [0.18, 0.44, 0.35],
            state: [0.18, 0.44, 0.35],
            surface: [0.98, 0.98, 0.96]
        };

        function vectorFromColor(color, fallbackColor) {
            return color
                ? [color.red / 255, color.green / 255, color.blue / 255]
                : fallbackColor;
        }

        function syncPalette() {
            const stateColor = resolveCssColor(getComputedStyle(refs.dockStateLabel).color);
            const accentColor = readPageColorToken('--tertiary', '--d-link-color', '--accent') || stateColor;
            const surfaceColor = readVisiblePageBackground()
                || resolveCssColor(getComputedStyle(refs.dock).backgroundColor);
            palette = {
                state: vectorFromColor(stateColor, palette.state),
                accent: vectorFromColor(accentColor, palette.accent),
                surface: vectorFromColor(surfaceColor, palette.surface)
            };
            paletteDirty = false;
        }

        function resizeCanvas() {
            const rect = canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return false;
            }

            const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
            const width = Math.max(1, Math.round(rect.width * pixelRatio));
            const height = Math.max(1, Math.round(rect.height * pixelRatio));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                gl.viewport(0, 0, width, height);
            }
            return true;
        }

        function activityForState() {
            if (animatedStates.has(state)) {
                return 1;
            }
            if (state === 'done') {
                return 0.48;
            }
            if (state === 'paused') {
                return 0.14;
            }
            return hovered ? 0.5 : 0.28;
        }

        function draw(timestamp = performance.now()) {
            if (contextLost || settings.minimized !== true || !resizeCanvas()) {
                return;
            }

            if (paletteDirty) {
                syncPalette();
            }
            pointer.x += (pointerTarget.x - pointer.x) * 0.2;
            pointer.y += (pointerTarget.y - pointer.y) * 0.2;
            gl.useProgram(program);
            gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
            gl.uniform1f(uniforms.time, timestamp / 1000);
            gl.uniform1f(uniforms.activity, activityForState());
            gl.uniform1f(uniforms.progress, clamp(progress, 0, 1));
            gl.uniform1f(uniforms.dark, host.dataset.theme === 'dark' ? 1 : 0);
            gl.uniform1f(uniforms.hover, hovered ? 1 : 0);
            gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
            gl.uniform3fv(uniforms.accent, palette.accent);
            gl.uniform3fv(uniforms.state, palette.state);
            gl.uniform3fv(uniforms.surface, palette.surface);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }

        function shouldAnimate() {
            return settings.minimized === true
                && !document.hidden
                && !reducedMotion?.matches
                && (animatedStates.has(state) || hovered);
        }

        function animate(timestamp) {
            if (!shouldAnimate() || contextLost) {
                frameId = null;
                draw(timestamp);
                return;
            }

            // 小尺寸材质层限制在约 30fps，视觉连续且不会长期占用完整刷新率。
            if (timestamp - lastDrawAt >= 32) {
                lastDrawAt = timestamp;
                draw(timestamp);
            }
            frameId = requestAnimationFrame(animate);
        }

        function wake() {
            if (settings.minimized !== true || contextLost) {
                if (frameId !== null) {
                    cancelAnimationFrame(frameId);
                    frameId = null;
                }
                return;
            }

            draw();
            if (shouldAnimate() && frameId === null) {
                frameId = requestAnimationFrame(animate);
            }
        }

        function updatePointer(event) {
            const rect = refs.dock.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }

            pointerTarget = {
                x: clamp((event.clientX - rect.left) / rect.width, 0.02, 0.98),
                // WebGL 纹理坐标从左下角开始，需要翻转浏览器的纵向坐标。
                y: 1 - clamp((event.clientY - rect.top) / rect.height, 0.02, 0.98)
            };
        }

        refs.dock.addEventListener('pointerenter', (event) => {
            hovered = true;
            updatePointer(event);
            wake();
        });
        refs.dock.addEventListener('pointermove', (event) => {
            updatePointer(event);
            if (frameId === null) {
                wake();
            }
        });
        refs.dock.addEventListener('pointerleave', () => {
            hovered = false;
            pointerTarget = { x: 0.5, y: 0.5 };
            wake();
        });
        canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            contextLost = true;
            host.dataset.dockFx = 'fallback';
            if (frameId !== null) {
                cancelAnimationFrame(frameId);
                frameId = null;
            }
        });
        canvas.addEventListener('webglcontextrestored', () => {
            // 浏览器恢复上下文后沿用 CSS 降级层，避免在页面阅读中重建着色器产生卡顿。
            contextLost = true;
            host.dataset.dockFx = 'fallback';
        });
        reducedMotion?.addEventListener?.('change', wake);
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('resize', wake, { passive: true });

        host.dataset.dockFx = 'webgl';
        requestAnimationFrame(wake);

        return {
            setState(nextState) {
                if (state === nextState) {
                    return;
                }
                state = nextState;
                paletteDirty = true;
                wake();
            },
            setProgress(nextProgress) {
                progress = clamp(Number(nextProgress) || 0, 0, 1);
                if (!shouldAnimate()) {
                    wake();
                }
            },
            setMinimized() {
                requestAnimationFrame(wake);
            },
            syncTheme() {
                paletteDirty = true;
                wake();
            }
        };
    }

    dockFluidEffect = createDockFluidEffect();

    function dockDetailForState(state) {
        switch (state) {
            case 'running':
                return `${Math.round(settings.speed)} 像素/秒`;
            case 'loading':
                return '正在衔接楼层';
            case 'waiting':
                return '正在确认记录';
            case 'recovering':
                return '重载当前楼层';
            case 'queue':
                return queueUiActive ? '持续补帖' : `保持 ${settings.queueLimit} 篇`;
            case 'cooldown':
                return '即将下一篇';
            case 'paused':
                return '点按继续';
            case 'done':
                return '点按重读';
            default:
                return '点按开始';
        }
    }

    function renderDockState(state = refs.shell.dataset.state || 'idle') {
        const copy = STATE_COPY[state] || STATE_COPY.idle;
        const detail = dockDetailForState(state);
        const activeReading = ['running', 'loading', 'waiting'].includes(state);
        const recovering = state === 'recovering';
        const queueActionActive = queueUiActive && isListRoute() && settings.mode === 'queue';
        const actionLabel = queueActionActive
            ? '停止连续阅读'
            : recovering
                ? '正在恢复'
                : activeReading
                    ? '暂停阅读'
                    : state === 'paused'
                        ? '继续阅读'
                        : state === 'done'
                            ? '重新阅读'
                            : '开始阅读';
        refs.dockStateLabel.textContent = copy.chip;
        refs.dockStateDetail.textContent = detail;
        refs.dock.setAttribute('aria-label', `澜阅快捷控制，${copy.title}`);
        refs.dockControl.title = `${actionLabel} · 拖动可移动`;
        refs.dockControl.setAttribute('aria-label', `${copy.title}，${detail}，${actionLabel}`);
        refs.dockControl.disabled = recovering;
        refs.dockExpand.setAttribute('aria-label', `展开阅读设置，当前${copy.title}`);
        dockFluidEffect?.setState(state);
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
        dockFluidEffect?.setMinimized(nextMinimized);

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
        renderDockState();

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
        if (!queueUiActive) {
            refs.queueSummaryCount.textContent = String(nextLimit);
        }
        renderDockState();

        if (persist) {
            StorageManager.save(settings);
        }
    }

    function setQueueSessionLimit(limit, persist = true) {
        const nextLimit = clamp(
            Math.round((Number(limit) || CONFIG.queueSessionDefaultItems) / 10) * 10,
            CONFIG.queueSessionMinItems,
            CONFIG.queueSessionMaxItems
        );
        settings.queueSessionLimit = nextLimit;
        refs.queueSessionLimit.value = String(nextLimit);
        refs.queueSessionCount.textContent = `${nextLimit} 篇`;
        if (!queueUiActive) {
            refs.queueSummaryLimit.textContent = String(nextLimit);
        }

        if (persist) {
            StorageManager.save(settings);
        }
    }

    let queueUiActive = false;
    function setQueueActiveUi(active, capacity = settings.queueLimit, totalLimit = settings.queueSessionLimit) {
        queueUiActive = Boolean(active);
        refs.queueStop.hidden = !queueUiActive;
        refs.queueSummaryCount.textContent = String(queueUiActive ? capacity : settings.queueLimit);
        refs.queueSummaryLimit.textContent = String(queueUiActive ? totalLimit : settings.queueSessionLimit);
        refs.queueNote.textContent = queueUiActive
            ? '设置变更下轮生效 · 前台间隔'
            : '读完自动补队列 · 前台间隔';
        renderDockState();
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
            const interactiveTarget = event.target.closest('button, input, label');
            if (event.button !== 0 || (interactiveTarget && interactiveTarget !== handle)) {
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
    let handlePersistentUnread = () => false;

    function nativePostStreamTail() {
        const stream = document.querySelector('.post-stream');
        if (!stream) {
            return { sentinel: null, complete: false, lastPostNumber: 0 };
        }

        let lastPost = stream.lastElementChild;
        while (lastPost && !lastPost.hasAttribute('data-post-number')) {
            lastPost = lastPost.previousElementSibling;
        }
        let sentinel = lastPost?.nextElementSibling || null;
        while (sentinel && !sentinel.matches('.load-more-sentinel')) {
            sentinel = sentinel.nextElementSibling;
        }

        return {
            sentinel,
            complete: Boolean(stream.querySelector(':scope > .post-stream__bottom-boundary')),
            lastPostNumber: Math.max(0, Number(lastPost?.getAttribute('data-post-number')) || 0)
        };
    }

    function createScrollController() {
        let state = 'idle';
        let running = false;
        let frameId = null;
        let lastFrameAt = 0;
        let lastHeight = getScrollMetrics().height;
        let bottomWaitElapsedMs = 0;
        let bottomReportElapsedMs = 0;
        let bottomReportQuietElapsedMs = 0;
        let bottomReportRetryPulsed = false;
        let currentSpeed = 0;
        let speedMultiplier = 1;
        let nextSpeedVariationAt = 0;
        let distance = 0;
        let scrollRemainder = 0;
        let elapsedBeforeRun = 0;
        let activeSince = 0;
        let manualPauseReadyAt = 0;
        let lastUiRefreshAt = 0;
        let detailOverride = '';
        let readingPlan = null;
        let readingPlanElapsedMs = 0;
        let nextPlanRefreshAt = 0;
        let viewportConfirmation = null;
        let nextReadStateScanAt = 0;
        let nextReadAheadScanAt = 0;
        let readAheadSentinel = null;
        let readAheadOriginalTranslate = '';
        let readAheadOriginalPriority = '';
        let readAheadShift = 0;
        let streamTail = { sentinel: null, complete: false, lastPostNumber: 0 };
        let streamStallElapsedMs = 0;
        let lastStreamPostNumber = 0;
        let consecutiveReadStateTimeouts = 0;
        let lastReadStateTimeoutAt = 0;
        const attemptedReadPosts = new Set();

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

        function resetBottomTracking() {
            bottomWaitElapsedMs = 0;
            bottomReportElapsedMs = 0;
            bottomReportQuietElapsedMs = 0;
            bottomReportRetryPulsed = false;
        }

        function restoreReadAhead() {
            if (readAheadSentinel?.isConnected) {
                if (readAheadOriginalTranslate) {
                    readAheadSentinel.style.setProperty(
                        'translate', readAheadOriginalTranslate, readAheadOriginalPriority
                    );
                } else {
                    readAheadSentinel.style.removeProperty('translate');
                }
            }
            readAheadSentinel = null;
            readAheadOriginalTranslate = '';
            readAheadOriginalPriority = '';
            readAheadShift = 0;
        }

        function refreshReadAhead(timestamp, force = false) {
            if (!force && timestamp < nextReadAheadScanAt && (!streamTail.sentinel || streamTail.sentinel.isConnected)) {
                return streamTail;
            }
            nextReadAheadScanAt = timestamp + CONFIG.readAheadScanMs;
            streamTail = nativePostStreamTail();
            if (streamTail.sentinel !== readAheadSentinel) {
                restoreReadAhead();
                if (streamTail.sentinel) {
                    readAheadSentinel = streamTail.sentinel;
                    readAheadOriginalTranslate = readAheadSentinel.style.getPropertyValue('translate');
                    readAheadOriginalPriority = readAheadSentinel.style.getPropertyPriority('translate');
                }
            }

            if (!readAheadSentinel) {
                return streamTail;
            }

            const viewport = Math.max(window.innerHeight, 1);
            const naturalTop = readAheadSentinel.getBoundingClientRect().top + readAheadShift;
            const lookahead = Math.min(viewport * CONFIG.readAheadScreens, Math.max(viewport * 2, settings.speed * 24));
            // 只移动不可见的原生加载哨兵，不改正文布局或当前滚动位置。
            // 原生 IntersectionObserver 会在读者抵达楼层末端前请求下一批。
            const shift = Math.round(clamp(naturalTop - viewport * 0.78, 0, lookahead));
            if (Math.abs(shift - readAheadShift) >= 8) {
                readAheadShift = shift;
                readAheadSentinel.style.setProperty('translate', `0 -${shift}px`);
            }
            return streamTail;
        }

        function distanceToNativeStreamEnd() {
            return readAheadSentinel?.isConnected
                ? readAheadSentinel.getBoundingClientRect().top + readAheadShift - window.innerHeight * 0.78
                : Number.POSITIVE_INFINITY;
        }

        function postNumberForReadState(indicator) {
            const numberedPost = indicator.closest('[data-post-number]');
            const dataNumber = Number(numberedPost?.getAttribute('data-post-number'));
            if (Number.isFinite(dataNumber) && dataNumber > 0) {
                return Math.floor(dataNumber);
            }

            const articleId = indicator.closest('article[id^="post_"]')?.id || '';
            const idNumber = Number(articleId.match(/^post_(\d+)$/)?.[1]);
            return Number.isFinite(idNumber) && idNumber > 0 ? Math.floor(idNumber) : 0;
        }

        function postElementForReadState(indicator) {
            return indicator.closest('.topic-post')
                || indicator.closest('article[id^="post_"]')
                || indicator.closest('[data-post-number]');
        }

        function visibleUnreadPostNumbers(readingBand = false) {
            const viewportHeight = Math.max(window.innerHeight, 1);
            const bandTop = readingBand
                ? viewportHeight * CONFIG.readConfirmBandTopRatio
                : 0;
            const bandBottom = readingBand
                ? viewportHeight * CONFIG.readConfirmBandBottomRatio
                : viewportHeight;
            const numbers = new Set();

            document.querySelectorAll('.read-state:not(.read)').forEach((indicator) => {
                const postNumber = postNumberForReadState(indicator);
                const postElement = postElementForReadState(indicator);
                if (!postNumber || !postElement) {
                    return;
                }

                const rect = postElement.getBoundingClientRect();
                if (readingBand && rect.bottom > bandBottom) {
                    return;
                }
                const overlap = Math.min(rect.bottom, bandBottom) - Math.max(rect.top, bandTop);
                const requiredOverlap = readingBand
                    ? Math.min(CONFIG.readConfirmMinVisiblePx, Math.max(18, rect.height * 0.2))
                    : 1;
                if (rect.width > 0 && rect.height > 0 && overlap >= requiredOverlap) {
                    numbers.add(postNumber);
                }
            });

            return [...numbers].sort((left, right) => left - right);
        }

        function unreadPostNumbers(numbers) {
            const unread = new Set(
                [...document.querySelectorAll('.read-state:not(.read)')]
                    .map(postNumberForReadState)
                    .filter(Boolean)
            );
            return numbers.filter((postNumber) => unread.has(postNumber));
        }

        function formatPostNumbers(numbers) {
            if (numbers.length === 0) {
                return '当前楼层';
            }
            if (numbers.length === 1) {
                return `${numbers[0]} 层`;
            }
            return `${numbers[0]}–${numbers[numbers.length - 1]} 层`;
        }

        function pulseNativeScroll() {
            const metrics = getScrollMetrics();
            const offset = metrics.remaining >= 1 ? 1 : metrics.top >= 1 ? -1 : 0;
            if (offset !== 0) {
                // 产生真实的滚动事件，让 Discourse 重新核对可见楼层，不直接触碰其上报接口。
                window.scrollBy(0, offset);
            }
        }

        function startViewportConfirmation(numbers) {
            const freshNumbers = numbers.filter((postNumber) => !attemptedReadPosts.has(postNumber));
            if (freshNumbers.length === 0) {
                return false;
            }

            viewportConfirmation = {
                numbers: freshNumbers,
                elapsedMs: 0,
                limitMs: CONFIG.readConfirmMinMs
                    + Math.random() * (CONFIG.readConfirmMaxMs - CONFIG.readConfirmMinMs),
                retryPulsed: false
            };
            return true;
        }

        function requestPersistentUnreadRecovery(numbers) {
            stop('paused', `站点连续未确认 ${formatPostNumbers(numbers)}`);
            queueMicrotask(() => {
                const handled = handlePersistentUnread(numbers);
                if (!handled) {
                    setState('paused', '阅读记录仍未确认，已停在当前帖');
                }
            });
        }

        function updateViewportConfirmation(timestamp, activeFrameMs) {
            if (!viewportConfirmation && timestamp >= nextReadStateScanAt) {
                nextReadStateScanAt = timestamp + CONFIG.readStateScanMs;
                startViewportConfirmation(visibleUnreadPostNumbers(true));
            }

            if (!viewportConfirmation) {
                return false;
            }

            viewportConfirmation.elapsedMs += activeFrameMs;
            if (
                !viewportConfirmation.retryPulsed
                && viewportConfirmation.elapsedMs >= CONFIG.readConfirmRetryPulseMs
            ) {
                viewportConfirmation.retryPulsed = true;
                pulseNativeScroll();
            }

            let pendingNumbers = viewportConfirmation.numbers;
            if (timestamp >= nextReadStateScanAt) {
                nextReadStateScanAt = timestamp + CONFIG.readStateScanMs;
                pendingNumbers = unreadPostNumbers(viewportConfirmation.numbers);
            }

            if (pendingNumbers.length === 0) {
                viewportConfirmation.numbers.forEach((postNumber) => attemptedReadPosts.add(postNumber));
                viewportConfirmation = null;
                consecutiveReadStateTimeouts = 0;
                setState('running', readingPlanSummary());
                return false;
            }

            viewportConfirmation.numbers = pendingNumbers;
            if (viewportConfirmation.elapsedMs >= viewportConfirmation.limitMs) {
                pendingNumbers.forEach((postNumber) => attemptedReadPosts.add(postNumber));
                viewportConfirmation = null;

                if (timestamp - lastReadStateTimeoutAt <= CONFIG.readConfirmFailureWindowMs) {
                    consecutiveReadStateTimeouts += 1;
                } else {
                    consecutiveReadStateTimeouts = 1;
                }
                lastReadStateTimeoutAt = timestamp;

                if (consecutiveReadStateTimeouts >= CONFIG.readConfirmReloadAfterBatches) {
                    requestPersistentUnreadRecovery(pendingNumbers);
                    return true;
                }

                setState('running', readingPlanSummary());
                return false;
            }

            const remainingSeconds = Math.max(
                1,
                Math.ceil((viewportConfirmation.limitMs - viewportConfirmation.elapsedMs) / 1000)
            );
            setState(
                'waiting',
                `正在确认 ${formatPostNumbers(pendingNumbers)} · 最多还需 ${remainingSeconds} 秒`
            );
            return true;
        }

        function normalizeReadingPlan(plan) {
            if (!plan) {
                return null;
            }

            const postCount = Math.max(1, Math.round(Number(plan.postCount) || 1));
            const minimumMs = clamp(
                Number(plan.minimumMs) || CONFIG.queueReadBaseMs + postCount * CONFIG.queueReadPerPostMs,
                CONFIG.queueReadMinMs,
                CONFIG.queueReadMaxMs
            );
            return { postCount, minimumMs };
        }

        function applyReadingPlan(plan) {
            const next = normalizeReadingPlan(plan);
            if (!next) {
                return false;
            }

            const merged = readingPlan
                ? {
                    postCount: Math.max(readingPlan.postCount, next.postCount),
                    minimumMs: Math.max(readingPlan.minimumMs, next.minimumMs)
                }
                : next;
            const changed = !readingPlan
                || merged.postCount !== readingPlan.postCount
                || merged.minimumMs !== readingPlan.minimumMs;
            readingPlan = merged;
            return changed;
        }

        function refreshReadingPlan(timestamp, force = false) {
            if (!readingPlan || (!force && timestamp < nextPlanRefreshAt)) {
                return false;
            }

            nextPlanRefreshAt = timestamp + CONFIG.queuePlanRefreshMs;
            return applyReadingPlan(createQueueReadingPlan());
        }

        function readingPlanRemainingMs() {
            return readingPlan
                ? Math.max(0, readingPlan.minimumMs - readingPlanElapsedMs)
                : 0;
        }

        function readingPlanSummary() {
            return readingPlan
                ? `连续阅读 · ${readingPlan.postCount} 层 · 至少 ${formatReadingDuration(readingPlan.minimumMs)}`
                : '';
        }

        function readingPlanWaitingDetail() {
            return readingPlan
                ? `按 ${readingPlan.postCount} 层规划 · 还需 ${formatReadingDuration(readingPlanRemainingMs())}`
                : '';
        }

        function setState(nextState, detail = '') {
            if (state === nextState && detailOverride === detail) {
                return;
            }

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
            const recovering = state === 'recovering';
            const controlIconState = queueActionActive ? 'stop' : running || recovering ? 'pause' : 'play';
            refs.controlIcons.forEach((icon) => {
                icon.toggleAttribute('hidden', icon.dataset.iconState !== controlIconState);
            });
            refs.controlLabel.textContent = queueActionActive
                ? '停止连续阅读'
                : recovering
                    ? '正在恢复'
                    : running
                        ? '暂停阅读'
                        : '开始阅读';
            refs.toggleButton.setAttribute(
                'aria-label',
                queueActionActive
                    ? '停止连续阅读'
                    : recovering
                        ? '正在恢复阅读记录'
                        : running
                            ? '暂停阅读'
                            : '开始阅读'
            );
            refs.toggleButton.disabled = recovering;
            renderDockState(state);
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
            dockFluidEffect?.setProgress(metrics.progress / 100);
        }

        function stop(nextState = 'paused', detail = '') {
            const wasRunning = running;
            if (running && activeSince) {
                elapsedBeforeRun += performance.now() - activeSince;
            }

            running = false;
            activeSince = 0;
            manualPauseReadyAt = 0;
            currentSpeed = 0;
            scrollRemainder = 0;
            viewportConfirmation = null;
            nextReadStateScanAt = 0;
            nextReadAheadScanAt = 0;
            restoreReadAhead();
            streamTail = { sentinel: null, complete: false, lastPostNumber: 0 };
            streamStallElapsedMs = 0;
            resetBottomTracking();

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

            const frameGapMs = Math.max(0, timestamp - lastFrameAt);
            const deltaSeconds = clamp(frameGapMs / 1000, 0, 0.08);
            const activeFrameMs = document.hidden ? 0 : Math.min(frameGapMs, 250);
            lastFrameAt = timestamp;
            // 连续阅读计划只累计可见页面中的有效运行时间，暂停或后台节流时间不会被算入。
            if (readingPlan) {
                readingPlanElapsedMs += activeFrameMs;
            }
            const readingPlanChanged = refreshReadingPlan(timestamp);
            if (timestamp >= nextSpeedVariationAt) {
                scheduleSpeedVariation(timestamp);
            }

            const before = getScrollMetrics();
            const heightGrew = before.height > lastHeight + 2;
            lastHeight = before.height;
            const tail = refreshReadAhead(timestamp);
            if (heightGrew || tail.lastPostNumber > lastStreamPostNumber) {
                streamStallElapsedMs = 0;
            }
            lastStreamPostNumber = tail.lastPostNumber;

            // 只有原生正文流确认已加载到末楼，页面剩余高度才可用于整篇限速。
            // 长帖尚有成千上万楼未加载时，用当前十几楼的高度摊总时长会把高速档压成爬行。
            const requestedSpeed = settings.speed * speedMultiplier;
            const remainingPlanMs = readingPlanRemainingMs();
            const paceLimit = readingPlan && tail.complete && remainingPlanMs > 0
                ? Math.max(1, before.remaining / Math.max(remainingPlanMs / 1000, 0.001))
                : Number.POSITIVE_INFINITY;
            const targetSpeed = Math.min(requestedSpeed, paceLimit);
            currentSpeed += (targetSpeed - currentSpeed) * Math.min(1, deltaSeconds * 1.8);
            currentSpeed = Math.min(currentSpeed, paceLimit);

            if (readingPlanChanged && state === 'running') {
                setState('running', readingPlanSummary());
            }

            if (heightGrew) {
                resetBottomTracking();
                setState('loading', readingPlan ? `已识别 ${readingPlan.postCount} 层 · 正在衔接后续内容` : '');
            }

            if (tail.sentinel?.isConnected && distanceToNativeStreamEnd() <= 0) {
                resetBottomTracking();
                const confirmingReadState = updateViewportConfirmation(timestamp, activeFrameMs);
                if (!running) {
                    return;
                }

                currentSpeed = 0;
                scrollRemainder = 0;
                if (!confirmingReadState) {
                    streamStallElapsedMs += activeFrameMs;
                    if (streamStallElapsedMs >= CONFIG.postLoadTimeoutMs) {
                        stop('paused', '后续楼层加载超时，请检查网络后继续');
                        return;
                    }
                    setState('loading', `站点正在加载后续楼层 · 已到 ${tail.lastPostNumber} 层`);
                }
            } else if (before.remaining > CONFIG.bottomThreshold) {
                resetBottomTracking();
                streamStallElapsedMs = 0;
                const confirmingReadState = updateViewportConfirmation(timestamp, activeFrameMs);
                if (!running) {
                    return;
                }

                if (confirmingReadState) {
                    currentSpeed = 0;
                    scrollRemainder = 0;
                } else {
                    if (!heightGrew && state !== 'running') {
                        setState('running', readingPlanSummary());
                    }

                    // 低速或高刷新率下，单帧位移可能不足 1px；先累计后再提交整数位移。
                    // 高 DPI/页面缩放会把 1px 量化成不同的实际距离，因此按真实位移回补误差。
                    scrollRemainder += currentSpeed * deltaSeconds;
                    const scrollPixels = Math.trunc(scrollRemainder);
                    if (scrollPixels !== 0) {
                        window.scrollBy(0, scrollPixels);
                        scrollRemainder -= getScrollMetrics().top - before.top;
                    }
                }
            } else {
                streamStallElapsedMs = 0;
                viewportConfirmation = null;
                scrollRemainder = 0;
                bottomWaitElapsedMs += activeFrameMs;
                bottomReportElapsedMs += activeFrameMs;

                const visibleUnreadNumbers = visibleUnreadPostNumbers(false);
                if (visibleUnreadNumbers.length === 0) {
                    bottomReportQuietElapsedMs += activeFrameMs;
                } else {
                    bottomReportQuietElapsedMs = 0;
                }

                if (
                    visibleUnreadNumbers.length > 0
                    && !bottomReportRetryPulsed
                    && bottomReportElapsedMs >= CONFIG.bottomReportRetryPulseMs
                ) {
                    bottomReportRetryPulsed = true;
                    pulseNativeScroll();
                }

                const remainingWait = Math.max(0, CONFIG.bottomWaitMs - bottomWaitElapsedMs);
                const remainingReadingTime = readingPlanRemainingMs();
                const reportConfirmed = visibleUnreadNumbers.length === 0
                    && bottomReportQuietElapsedMs >= CONFIG.bottomReportQuietMs;
                const reportTimedOut = bottomReportElapsedMs >= CONFIG.bottomReportTimeoutMs;
                const completionReady = remainingWait <= 0 && remainingReadingTime <= 0;
                if (completionReady && reportConfirmed) {
                    stop('done');
                    return;
                }

                if (completionReady && reportTimedOut && visibleUnreadNumbers.length > 0) {
                    requestPersistentUnreadRecovery(visibleUnreadNumbers);
                    return;
                }

                const reportWaitingDetail = reportTimedOut
                    ? `站点仍未确认 · ${formatPostNumbers(visibleUnreadNumbers)} · 计划结束后恢复`
                    : `等待站点记录 · ${formatPostNumbers(visibleUnreadNumbers)} · 最多 ${Math.ceil((CONFIG.bottomReportTimeoutMs - bottomReportElapsedMs) / 1000)} 秒`;
                setState(
                    'waiting',
                    visibleUnreadNumbers.length > 0
                        ? reportWaitingDetail
                        : remainingReadingTime > 0
                        ? readingPlanWaitingDetail()
                        : remainingWait > 0
                            ? `等待懒加载 · ${Math.ceil(remainingWait / 1000)} 秒`
                            : '正在确认站点记录'
                );
                // 持续贴近底部，以便触发 Discourse 的懒加载观察器。
                window.scrollTo(0, before.maximum);
            }

            const after = getScrollMetrics();
            distance += Math.abs(after.top - before.top);
            renderStats(false, timestamp);
            frameId = requestAnimationFrame(tick);
        }

        function start(plan) {
            if (running || !isTopicRoute()) {
                return;
            }

            if (plan !== undefined) {
                readingPlan = null;
                readingPlanElapsedMs = 0;
                nextPlanRefreshAt = 0;
                applyReadingPlan(plan);
            }

            running = true;
            activeSince = performance.now();
            // 点击开始前残留的触控板惯性滚轮事件不应立刻把刚启动的阅读再次暂停。
            manualPauseReadyAt = activeSince + CONFIG.manualPauseGraceMs;
            lastFrameAt = activeSince;
            lastHeight = getScrollMetrics().height;
            resetBottomTracking();
            viewportConfirmation = null;
            nextReadStateScanAt = 0;
            nextReadAheadScanAt = 0;
            streamStallElapsedMs = 0;
            lastStreamPostNumber = 0;
            refreshReadingPlan(activeSince, true);
            refreshReadAhead(activeSince, true);
            const initialMetrics = getScrollMetrics();
            const initialPlanMs = readingPlanRemainingMs();
            const initialPaceLimit = readingPlan && streamTail.complete && initialPlanMs > 0
                ? Math.max(1, initialMetrics.remaining / Math.max(initialPlanMs / 1000, 0.001))
                : Number.POSITIVE_INFINITY;
            currentSpeed = Math.min(
                settings.speed,
                Math.max(8, settings.speed * 0.35),
                initialPaceLimit
            );
            scrollRemainder = 0;
            speedMultiplier = 1;
            nextSpeedVariationAt = activeSince + CONFIG.speedVariationIntervalMinMs;
            setState('running', readingPlanSummary());
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
            readingPlan = null;
            readingPlanElapsedMs = 0;
            nextPlanRefreshAt = 0;
            viewportConfirmation = null;
            nextReadStateScanAt = 0;
            nextReadAheadScanAt = 0;
            streamStallElapsedMs = 0;
            lastStreamPostNumber = 0;
            consecutiveReadStateTimeouts = 0;
            lastReadStateTimeoutAt = 0;
            attemptedReadPosts.clear();
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
            pauseForManualInput(detail = '检测到手动操作') {
                if (!running || performance.now() < manualPauseReadyAt) {
                    return false;
                }

                stop('paused', detail);
                return true;
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

            const segments = url.pathname.split('/').filter(Boolean);
            if (!['t', 'n'].includes(segments[0])) {
                return null;
            }

            const firstPartIsId = /^\d+$/.test(segments[1] || '');
            const id = firstPartIsId
                ? segments[1]
                : /^\d+$/.test(segments[2] || '')
                    ? segments[2]
                    : '';
            if (!id) {
                return null;
            }

            // 队列始终从话题入口开始，不继承楼层、查询参数或锚点。
            url.pathname = firstPartIsId
                ? `/${segments[0]}/${id}`
                : `/${segments[0]}/${segments[1]}/${id}`;
            url.search = '';
            url.hash = '';
            return { id, kind: segments[0], url: url.href };
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

    function routeIdentity(value = window.location.href) {
        const topic = normalizeTopicUrl(value);
        if (topic) {
            return `topic:${topic.kind}:${topic.id}`;
        }

        try {
            const url = new URL(value, window.location.origin);
            const listMatch = url.pathname.match(/^\/(new|unread|unseen|latest)(?:\/|$)/);
            if (url.origin === window.location.origin && listMatch) {
                return `list:${listMatch[1]}`;
            }

            return `other:${url.origin}${url.pathname}`;
        } catch {
            return 'other:invalid';
        }
    }

    function collectTopicsFromList(limit, excludedIds = new Set()) {
        const topics = [];
        const seen = new Set(excludedIds);
        const rows = document.querySelectorAll('.topic-list-item, .latest-topic-list-item');

        for (const row of rows) {
            if (topics.length >= limit) {
                break;
            }

            // Discourse 的 visited 表示话题已打开过，即使后来又有新回复也不作为“新帖”入队。
            // 四种列表都要求存在站点自己的未看/未读标记，不能仅凭列表入口判断整行未读。
            const isVisited = row.matches('.visited, .read');
            const hasUnreadMarker = row.matches('.unseen-topic, .unread-posts')
                || Boolean(row.querySelector('.badge-notification.new-topic, .badge-notification.unread-posts, .new-topic, .unread-posts'));
            if (isVisited || !hasUnreadMarker) {
                continue;
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
                capacity: CONFIG.queueDefaultItems,
                totalLimit: CONFIG.queueSessionDefaultItems,
                startedAt: 0,
                updatedAt: 0,
                cooldownRemainingMs: CONFIG.queueCooldownMs
            };
        },

        normalize(raw) {
            const empty = this.empty();
            const seen = new Set();
            const items = Array.isArray(raw?.items)
                ? raw.items
                    .map((item) => {
                        const normalizedTopic = item && normalizeTopicUrl(item.url);
                        if (!normalizedTopic || seen.has(normalizedTopic.id)) {
                            return null;
                        }
                        seen.add(normalizedTopic.id);
                        return normalizedTopic
                            ? {
                                id: normalizedTopic.id,
                                url: normalizedTopic.url,
                                title: String(item.title || `话题 ${normalizedTopic.id}`)
                            }
                            : null;
                    })
                    .filter(Boolean)
                    .slice(0, CONFIG.queueSessionMaxItems)
                : [];
            const updatedAt = Number(raw?.updatedAt) || 0;
            const stale = !updatedAt || Date.now() - updatedAt > CONFIG.queueMaxAgeMs;
            const phase = ['reading', 'cooldown', 'refilling'].includes(raw?.phase) ? raw.phase : empty.phase;
            const sourceUrl = normalizeListUrl(raw?.sourceUrl);
            const capacity = clamp(
                Math.floor(Number(raw?.capacity) || settings.queueLimit),
                CONFIG.queueMinItems,
                CONFIG.queueMaxItems
            );
            const totalLimit = clamp(
                Math.max(items.length, Math.floor(Number(raw?.totalLimit) || settings.queueSessionLimit)),
                CONFIG.queueSessionMinItems,
                CONFIG.queueSessionMaxItems
            );

            return {
                active: Boolean(raw?.active) && !stale && Boolean(sourceUrl)
                    && (items.length > 0 || phase === 'refilling'),
                items,
                index: clamp(Math.floor(Number(raw?.index) || 0), 0, items.length),
                phase,
                sourceUrl,
                capacity,
                totalLimit,
                startedAt: Number(raw?.startedAt) || 0,
                updatedAt,
                cooldownRemainingMs: clamp(
                    Number.isFinite(Number(raw?.cooldownRemainingMs))
                        ? Number(raw.cooldownRemainingMs)
                        : CONFIG.queueCooldownMs,
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

    function navigateWithinSite(value) {
        try {
            const url = new URL(value, window.location.origin);
            if (url.origin !== window.location.origin) {
                return false;
            }

            // 通过普通同源链接进入下一页，让 Discourse 的路由层有机会先刷新原生阅读计时。
            // 若当前版本未接管链接，浏览器仍会按默认行为完成同标签页导航。
            const anchor = document.createElement('a');
            anchor.href = url.href;
            anchor.hidden = true;
            anchor.tabIndex = -1;
            anchor.setAttribute('aria-hidden', 'true');
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            return true;
        } catch {
            return false;
        }
    }

    const ReadRecovery = {
        maxAgeMs: 5 * 60 * 1000,

        load() {
            try {
                const value = JSON.parse(sessionStorage.getItem(APP.recoveryStorageKey) || 'null');
                const requestedAt = Number(value?.requestedAt) || 0;
                if (
                    !value
                    || !/^\d+$/.test(String(value.topicId || ''))
                    || Date.now() - requestedAt > this.maxAgeMs
                ) {
                    this.clear();
                    return null;
                }

                return {
                    topicId: String(value.topicId),
                    reloadCount: Math.max(0, Math.floor(Number(value.reloadCount) || 0)),
                    requestedAt,
                    resume: Boolean(value.resume),
                    targetPostNumber: Math.max(0, Math.floor(Number(value.targetPostNumber) || 0))
                };
            } catch {
                this.clear();
                return null;
            }
        },

        save(value) {
            try {
                sessionStorage.setItem(APP.recoveryStorageKey, JSON.stringify(value));
                return true;
            } catch (error) {
                console.warn(`[${APP.name}] 阅读记录恢复状态保存失败。`, error);
                return false;
            }
        },

        clear() {
            try {
                sessionStorage.removeItem(APP.recoveryStorageKey);
            } catch {
                // 会话存储不可用时不影响基本阅读。
            }
        },

        syncCurrentRoute() {
            const recovery = this.load();
            if (recovery && recovery.topicId !== topicIdFromUrl(window.location.href)) {
                this.clear();
                return null;
            }
            return recovery;
        },

        shouldResumeCurrent() {
            return Boolean(this.syncCurrentRoute()?.resume);
        },

        markResumeStarted() {
            const recovery = this.syncCurrentRoute();
            if (!recovery?.resume) {
                return;
            }
            recovery.resume = false;
            this.save(recovery);
        },

        requestReload(numbers) {
            const topic = normalizeTopicUrl(window.location.href);
            if (!topic) {
                return false;
            }

            const existing = this.load();
            if (existing?.topicId === topic.id && existing.reloadCount >= 1) {
                return false;
            }

            const targetPostNumber = Math.max(0, Math.floor(Number(numbers[0]) || 0));
            const target = new URL(topic.url);
            target.search = window.location.search;
            if (targetPostNumber > 0) {
                target.pathname = `${target.pathname.replace(/\/$/, '')}/${targetPostNumber}`;
            }
            const targetUrl = target.href;
            const saved = this.save({
                topicId: topic.id,
                reloadCount: 1,
                requestedAt: Date.now(),
                resume: true,
                targetPostNumber
            });
            if (!saved) {
                return false;
            }

            window.setTimeout(() => {
                // 仅重载当前话题的当前楼层，不新建标签页，也不绕过 Discourse 的原生阅读链路。
                window.location.replace(targetUrl);
            }, 1200);
            return true;
        }
    };

    function createQueueManager() {
        let session = QueueStorage.load();
        let cooldownFrame = null;
        let navigationTimer = null;
        let cooldownLastAt = 0;
        let lastCooldownSaveSecond = -1;
        let refillGeneration = 0;

        function currentItem() {
            return session.items[session.index] || null;
        }

        function queueLabel() {
            if (!session.active) {
                return '队列未建立';
            }
            const completed = Math.min(
                session.items.length,
                session.index + (session.phase === 'cooldown' ? 1 : 0)
            );
            return `已读 ${completed} · 待读 ${session.items.length - completed}`;
        }

        function save() {
            session = QueueStorage.save(session);
            setQueueActiveUi(session.active, session.capacity, session.totalLimit);
        }

        function cancelTimers() {
            refillGeneration += 1;
            if (cooldownFrame !== null) {
                cancelAnimationFrame(cooldownFrame);
                cooldownFrame = null;
            }
            if (navigationTimer !== null) {
                clearTimeout(navigationTimer);
                navigationTimer = null;
            }
        }

        function onSourceList() {
            if (!isListRoute() || !session.sourceUrl) {
                return false;
            }
            const source = new URL(session.sourceUrl);
            return window.location.origin === source.origin && window.location.pathname === source.pathname;
        }

        function listRows() {
            return document.querySelectorAll('.topic-list-item, .latest-topic-list-item');
        }

        function listFingerprint() {
            const rows = listRows();
            const last = rows[rows.length - 1];
            return `${rows.length}:${last?.getAttribute('data-topic-id') || last?.querySelector('a.title')?.href || ''}`;
        }

        function listLoadSentinel() {
            const rows = listRows();
            const last = rows[rows.length - 1];
            return [...document.querySelectorAll('.load-more-sentinel')].find((element) =>
                !element.closest('.post-stream')
                && (!last || Boolean(last.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
            ) || null;
        }

        function waitForListChange(predicate, timeoutMs) {
            if (predicate()) {
                return Promise.resolve(true);
            }
            return new Promise((resolve) => {
                const finish = (changed) => {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(changed);
                };
                const observer = new MutationObserver(() => {
                    if (predicate()) {
                        finish(true);
                    }
                });
                const timer = window.setTimeout(() => finish(false), timeoutMs);
                observer.observe(document.body, { childList: true, subtree: true });
            });
        }

        function waitUntilVisible() {
            if (!document.hidden) {
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                const resume = () => {
                    if (!document.hidden) {
                        document.removeEventListener('visibilitychange', resume);
                        resolve();
                    }
                };
                document.addEventListener('visibilitychange', resume);
            });
        }

        async function enterListSentinel(sentinel) {
            const original = sentinel.style.getPropertyValue('translate');
            const priority = sentinel.style.getPropertyPriority('translate');
            // 同一哨兵在追加列表后可能始终留在视口内；先短暂移出再移回，
            // 让站点自己的 IntersectionObserver 可以继续请求下一批列表。
            sentinel.style.setProperty('translate', `0 ${Math.max(window.innerHeight * 2, 1200)}px`);
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (original) {
                sentinel.style.setProperty('translate', original, priority);
            } else {
                sentinel.style.removeProperty('translate');
            }
            if (sentinel.isConnected) {
                sentinel.scrollIntoView({ block: 'end', behavior: 'auto' });
            }
        }

        async function refillFromList() {
            const generation = ++refillGeneration;
            const stillRefilling = () => generation === refillGeneration
                && session.active && session.phase === 'refilling' && onSourceList();
            scrollController.showState('queue', `${queueLabel()} · 正在补充新帖`);

            await waitForListChange(() => listRows().length > 0, 10000);
            if (!stillRefilling()) {
                return;
            }

            let added = 0;
            let loads = 0;
            let stalls = 0;
            while (stillRefilling()) {
                await waitUntilVisible();
                if (!stillRefilling()) {
                    return;
                }

                const pending = session.items.length - session.index;
                const needed = Math.min(session.capacity - pending, session.totalLimit - session.items.length);
                if (needed <= 0) {
                    break;
                }

                const seen = new Set(session.items.map((item) => item.id));
                const candidates = collectTopicsFromList(needed, seen);
                if (candidates.length > 0) {
                    session.items.push(...candidates);
                    added += candidates.length;
                    save();
                    scrollController.showState('queue', `${queueLabel()} · 已补充 ${added} 篇`);
                    continue;
                }

                const sentinel = listLoadSentinel();
                if (!sentinel || loads >= CONFIG.queueRefillMaxLoads || stalls >= 2) {
                    break;
                }

                const before = listFingerprint();
                loads += 1;
                await enterListSentinel(sentinel);
                if (!stillRefilling()) {
                    return;
                }
                const changed = await waitForListChange(
                    () => listFingerprint() !== before,
                    CONFIG.queueListLoadWaitMs
                );
                if (!stillRefilling()) {
                    return;
                }
                stalls = changed ? 0 : stalls + 1;
            }

            if (!stillRefilling()) {
                return;
            }
            if (session.index >= session.items.length) {
                complete(session.items.length > 0
                    ? `连续阅读完成 · 共 ${session.items.length} 篇，列表暂无新帖`
                    : '当前列表没有可阅读的新帖');
                return;
            }

            session.phase = 'reading';
            save();
            scrollController.showState('queue', `${queueLabel()} · ${added > 0 ? `补充 ${added} 篇` : '继续剩余篇目'}`);
            navigationTimer = window.setTimeout(navigateToCurrent, 350);
        }

        function launchRefillFromList() {
            const startedAt = session.startedAt;
            refillFromList().catch((error) => {
                console.warn(`[${APP.name}] 连续阅读补队列失败。`, error);
                if (session.active && session.phase === 'refilling' && session.startedAt === startedAt) {
                    stop('连续阅读已停止：补充队列失败，请重试');
                }
            });
        }

        function startRefill() {
            cancelTimers();
            session.phase = 'refilling';
            save();
            if (onSourceList()) {
                launchRefillFromList();
                return;
            }
            navigationTimer = window.setTimeout(() => {
                if (!navigateWithinSite(session.sourceUrl)) {
                    stop('连续阅读已停止：无法返回原列表补充新帖');
                }
            }, 350);
        }

        function navigateToCurrent() {
            if (!session.active) {
                return;
            }
            const item = currentItem();
            if (!item) {
                if (session.items.length < session.totalLimit) {
                    startRefill();
                } else {
                    complete();
                }
                return;
            }

            session.phase = 'reading';
            session.cooldownRemainingMs = CONFIG.queueCooldownMs;
            save();
            if (!navigateWithinSite(item.url)) {
                stop('连续阅读已停止：下一篇地址无效');
            }
        }

        function complete(detail = `连续阅读完成 · 共 ${session.items.length} 篇`) {
            const returnUrl = session.sourceUrl;
            cancelTimers();
            session.active = false;
            session.phase = 'idle';
            save();
            scrollController.showState('done', detail);

            if (isTopicRoute() && returnUrl) {
                navigationTimer = window.setTimeout(() => {
                    navigateWithinSite(returnUrl);
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
                    if (session.index >= session.totalLimit) {
                        complete();
                        return;
                    }

                    const pending = session.items.length - session.index;
                    if (session.items.length < session.totalLimit && pending <= CONFIG.queueRefillThreshold) {
                        startRefill();
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

            cancelTimers();
            session = {
                active: true,
                items: [],
                index: 0,
                phase: 'refilling',
                sourceUrl: normalizeListUrl(window.location.href),
                capacity: settings.queueLimit,
                totalLimit: settings.queueSessionLimit,
                startedAt: Date.now(),
                updatedAt: Date.now(),
                cooldownRemainingMs: CONFIG.queueCooldownMs
            };
            save();
            launchRefillFromList();
        }

        function currentTopicMatchesQueue() {
            const item = currentItem();
            return Boolean(item && topicIdFromUrl(window.location.href) === item.id);
        }

        function onRouteReady() {
            session = QueueStorage.load();
            setQueueActiveUi(session.active, session.capacity, session.totalLimit);

            if (!session.active) {
                return false;
            }

            if (settings.mode !== 'queue') {
                setMode('queue');
            }

            if (isListRoute()) {
                if (!onSourceList()) {
                    stop('连续阅读已停止：已离开原列表');
                    return false;
                }
                if (session.phase === 'refilling') {
                    launchRefillFromList();
                } else if (session.phase === 'cooldown') {
                    runCooldown();
                } else {
                    scrollController.showState('queue', `${queueLabel()} · 准备继续`);
                    navigationTimer = window.setTimeout(navigateToCurrent, 700);
                }
                return true;
            }

            if (session.phase === 'refilling' && isTopicRoute()) {
                scrollController.showState('queue', `${queueLabel()} · 返回列表补充新帖`);
                navigationTimer = window.setTimeout(() => navigateWithinSite(session.sourceUrl), 350);
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

        setQueueActiveUi(session.active, session.capacity, session.totalLimit);

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
    handleScrollDone = () => {
        ReadRecovery.clear();
        queueManager.onTopicDone();
    };
    handlePersistentUnread = (numbers) => {
        if (ReadRecovery.requestReload(numbers)) {
            scrollController.showState(
                'recovering',
                `连续蓝点未消失 · 正在重载 ${numbers[0] || '当前'} 层`
            );
            window.setTimeout(() => {
                if (refs.shell.dataset.state !== 'recovering') {
                    return;
                }

                ReadRecovery.clear();
                const detail = '当前楼层重载未完成，已停下以避免循环';
                if (queueManager.isActive()) {
                    queueManager.stop(detail);
                } else {
                    scrollController.showState('paused', detail);
                }
            }, 8000);
            return true;
        }

        const detail = '重载后阅读记录仍未确认，已停在当前帖，请检查网络后重试';
        if (queueManager.isActive()) {
            queueManager.stop(detail);
        } else {
            scrollController.showState('paused', detail);
        }
        return true;
    };

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
    let resumeAfterVisibilityPause = false;
    async function activateCurrentRoute() {
        const activation = ++routeActivation;
        const supported = isSupportedRoute();
        resumeAfterVisibilityPause = false;
        host.hidden = !supported;
        scrollController.resetForRoute();
        ReadRecovery.syncCurrentRoute();

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

        const shouldStartQueue = queueManager.shouldAutoStartCurrentTopic();
        const shouldResumeRecovery = ReadRecovery.shouldResumeCurrent();
        const shouldStart = shouldStartQueue
            || shouldResumeRecovery
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

        if (shouldResumeRecovery) {
            ReadRecovery.markResumeStarted();
        }
        scrollController.start(shouldStartQueue ? createQueueReadingPlan() : null);
    }

    function handlePrimaryAction() {
        if (refs.shell.dataset.state === 'recovering') {
            return;
        }

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
        if (settings.minimized && dragController.wasRecentDrag()) {
            return;
        }

        if (action === 'toggle' || action === 'dock-toggle') {
            handlePrimaryAction();
        } else if (action === 'minimize') {
            setMinimized(true);
        } else if (action === 'expand') {
            setMinimized(false);
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

    refs.queueSessionLimit.addEventListener('input', (event) => {
        setQueueSessionLimit(Number(event.currentTarget.value));
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
        if (
            !event.isTrusted
            || !settings.pauseOnManualInput
            || !scrollController.isRunning()
            || eventCameFromPanel(event)
        ) {
            return;
        }

        scrollController.pauseForManualInput('检测到手动操作');
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
        if (event.isTrusted && settings.pauseOnManualInput && manualScrollKeys.has(event.code)) {
            scrollController.pauseForManualInput('检测到手动翻页');
        }
    }, true);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && settings.autoPauseOnHidden && scrollController.isRunning()) {
            resumeAfterVisibilityPause = true;
            scrollController.pause('页面进入后台，已自动暂停');
        } else if (!document.hidden && resumeAfterVisibilityPause) {
            resumeAfterVisibilityPause = false;
            scrollController.start();
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
    let lastRouteIdentity = routeIdentity(lastUrl);
    function handleLocationChange() {
        if (window.location.href === lastUrl) {
            return;
        }

        lastUrl = window.location.href;
        const nextRouteIdentity = routeIdentity(lastUrl);
        if (nextRouteIdentity === lastRouteIdentity) {
            // Discourse 会随阅读进度更新当前楼层号；这仍是同一帖子，不能重置滚动状态。
            return;
        }

        lastRouteIdentity = nextRouteIdentity;
        activateCurrentRoute();
        if (isSupportedRoute()) {
            requestAnimationFrame(() => dragController.clampToViewport());
        }
    }

    const routeObserver = new MutationObserver(handleLocationChange);
    routeObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', () => window.setTimeout(handleLocationChange, 0));

    let themeSyncFrame = null;
    function scheduleThemeSync() {
        if (themeSyncFrame !== null) {
            return;
        }

        themeSyncFrame = requestAnimationFrame(() => {
            themeSyncFrame = null;
            syncTheme();
        });
    }

    const themeObserver = new MutationObserver(scheduleThemeSync);
    const themeAttributeFilter = ['class', 'style', 'data-color-scheme', 'data-theme', 'data-theme-id'];
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: themeAttributeFilter });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: themeAttributeFilter });

    // Discourse 切换主题时可能替换主题样式表而不修改 body 类名，因此同时观察 head。
    const themeStylesheetObserver = new MutationObserver(scheduleThemeSync);
    themeStylesheetObserver.observe(document.head, {
        attributes: true,
        attributeFilter: ['href', 'media', 'disabled'],
        childList: true,
        subtree: true
    });

    const preferredColorScheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    preferredColorScheme?.addEventListener?.('change', scheduleThemeSync);
    window.addEventListener('pageshow', scheduleThemeSync);

    setSpeed(settings.speed, false);
    setQueueLimit(settings.queueLimit, false);
    setQueueSessionLimit(settings.queueSessionLimit, false);
    setMode(settings.mode, false);
    syncTheme();
    activateCurrentRoute();
    requestAnimationFrame(() => dragController.clampToViewport());

    console.info(
        `[${APP.name}] v${APP.version} 已加载。快捷键：Alt+S 开始/暂停，Alt+↑/↓ 调速，Alt+M 最小化。`
    );
})();
