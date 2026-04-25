// ==UserScript==
// @name         Tribal Wars - Smart Automation
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Checklist inteligente: bandeiras, estatua e paladino em segundo plano automaticamente
// @author       You
// @match        *://*.tribalwars.com.br/*
// @match        *://*.divoke-kmene.sk/*
// @match        *://*.guerrastribales.es/*
// @match        *://*.die-staemme.de/*
// @match        *://*.tribalwars.us/*
// @match        *://*.voynaplemyon.com/*
// @match        *://*.tribalwars.com/*
// @match        *://*.tribalwars.nl/*
// @match        *://*.fyletikesmaxes.gr/*
// @match        *://*.guerretribale.fr/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      api.groq.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

   // ============================================================
    // CONFIG - VERSÃO TURBO (LOOP CONTÍNUO & RUSH GRÁTIS)
    // SEM IA PARA DECISÕES OPERACIONAIS
    // ============================================================
    var CONFIG = {
        debug: true,
        autoAssignFlag: true,
        autoRecruitKnight: true,
        autoBuildStatue: true,
        autoRushStatue: true,    // Finaliza estátua com ouro se disponível
        checklistDelay: 1000,    // Delay inicial reduzido para 1s

        // --- OTIMIZAÇÕES DE PERFORMANCE ---
        mainLoopInterval: 20000, // Ciclo padrão: 20s base + ±2s jitter para evitar sincronização
        freeRushMinutes: 3,      // Finaliza construções grátis se faltar menos de 3 minutos

        // Cache e debounce
        cacheExpiryMs: 5000,     // Cache expira em 5 segundos
        requestDebounceMs: 500,  // Debounce entre requisições

        // Paralelismo controlado
        maxConcurrentRequests: 3,// Máximo de requisições simultâneas

        // Batch processing
        processBatchSize: 5,     // Processar até 5 tarefas por ciclo

        // Modo Observação: analisa sem executar
        observationMode: GM_getValue('tw_obs_mode', false)
    };

    // Cache system para evitar requisições redundantes
    var RequestCache = {
        _cache: {},
        _timestamps: {},
        _maxSize: 200, // limite máximo de entradas simultâneas

        get: function(key) {
            if (this._cache[key] && this._timestamps[key]) {
                var age = Date.now() - this._timestamps[key];
                if (age < CONFIG.cacheExpiryMs) {
                    return this._cache[key];
                } else {
                    delete this._cache[key];
                    delete this._timestamps[key];
                }
            }
            return null;
        },

        set: function(key, value) {
            // Evicção LRU: remove a entrada mais antiga se o limite for atingido
            var keys = Object.keys(this._cache);
            if (keys.length >= this._maxSize) {
                var oldest = keys.reduce(function(a, b) {
                    return (this._timestamps[a] || 0) < (this._timestamps[b] || 0) ? a : b;
                }.bind(this));
                delete this._cache[oldest];
                delete this._timestamps[oldest];
            }
            this._cache[key] = value;
            this._timestamps[key] = Date.now();
        },

        clear: function() {
            this._cache = {};
            this._timestamps = {};
        },

        // Limpeza de entradas expiradas (chamada periodicamente e em cada coleta)
        cleanup: function() {
            var now = Date.now();
            for (var key in this._timestamps) {
                if (now - this._timestamps[key] > CONFIG.cacheExpiryMs * 2) {
                    delete this._cache[key];
                    delete this._timestamps[key];
                }
            }
        }
    };

    // Rate limiter para controlar requisições simultâneas
    var RateLimiter = {
        _activeRequests: 0,
        _queue: [],

        acquire: function() {
            return new Promise((resolve) => {
                if (this._activeRequests < CONFIG.maxConcurrentRequests) {
                    this._activeRequests++;
                    resolve();
                } else {
                    this._queue.push(resolve);
                }
            });
        },

        release: function() {
            if (this._activeRequests <= 0) return;
            this._activeRequests--;
            if (this._queue.length > 0 && this._activeRequests < CONFIG.maxConcurrentRequests) {
                var next = this._queue.shift();
                this._activeRequests++;
                next();
            }
        }
    };
    // ============================================================
    // ESTRATÉGIAS DE CRESCIMENTO (Pesos de 1 a 10)
    // ============================================================
    var STRATEGIES = {
        'BALANCED': { wood: 8, stone: 8, iron: 7, storage: 6, main: 5, farm: 5, barracks: 4, wall: 3, smith: 3, stable: 2 },
        'ECONOMY':  { wood: 10, stone: 10, iron: 9, storage: 7, main: 6, farm: 5, market: 3, wall: 1 },
        'MILITARY': { barracks: 10, stable: 8, smith: 7, farm: 9, iron: 7, wood: 5, stone: 5, wall: 6, main: 5 }
    };




    // ============================================================
    // ROADMAP / MARCOS ESTRATÉGICOS (METAS DO JOGO)
    // ============================================================
    // Milestones globais: fundações universais que toda aldeia constrói primeiro
    const MILESTONES_GLOBAL = [
        { id: 'unlock_statue',   label: 'Erigir Estátua',       reqs: { statue: 1 } },
        { id: 'hq_early',        label: 'HQ Nv 5',              reqs: { main: 5 } },
        { id: 'unlock_barracks', label: 'Quartel de Tropa',      reqs: { barracks: 1 } },
        { id: 'unlock_smith',    label: 'Caminho do Ferreiro',   reqs: { smith: 1 } },
        { id: 'hq_mid',          label: 'HQ Nv 10',             reqs: { main: 10 } },
        { id: 'unlock_stable',   label: 'Desbloqueio Estábulo', reqs: { stable: 1 } },
        { id: 'quartel_base',    label: 'Quartel Base',         reqs: { barracks: 5 } },
    ];

    // Milestones por perfil: roadmap divergente após as fundações globais
    const MILESTONES_BY_PROFILE = {
        // Aldeia econômica: maximizar produção de recursos e capacidade de armazém
        economic: [
            { id: 'eco_base',     label: 'Base Econômica',     reqs: { wood: 10, stone: 10, iron: 8 } },
            { id: 'eco_market',   label: 'Mercado Ativo',      reqs: { market: 5, storage: 8 } },
            { id: 'eco_scale',    label: 'Escala Econômica',   reqs: { wood: 15, stone: 15, iron: 15 } },
            { id: 'eco_advanced', label: 'Economia Avançada',  reqs: { wood: 20, stone: 20, iron: 18, storage: 15 } },
        ],
        // Aldeia militar: capacidade ofensiva — estábulo, ferreiro e quartel em foco
        military: [
            { id: 'mil_stable',     label: 'Desbloqueio Estábulo', reqs: { stable: 1 } },
            { id: 'mil_smith10',    label: 'Ferreiro Nv 10',       reqs: { smith: 10 } },
            { id: 'mil_barracks10', label: 'Quartel Nv 10',        reqs: { barracks: 10, stable: 5 } },
            { id: 'mil_wall',       label: 'Muralha Defensiva',    reqs: { wall: 10 } },
            { id: 'mil_full',       label: 'Arsenal Completo',     reqs: { barracks: 20, stable: 15, smith: 20 } },
        ],
        // Aldeia support: muralha alta, igreja, storage — resistência máxima
        support: [
            { id: 'sup_wall10',   label: 'Muralha Nv 10',       reqs: { wall: 10 } },
            { id: 'sup_church',   label: 'Igreja Ativa',         reqs: { church: 1 } },
            { id: 'sup_storage',  label: 'Storage Ampliado',     reqs: { storage: 15 } },
            { id: 'sup_wall20',   label: 'Muralha Máxima',       reqs: { wall: 20 } },
        ],
        // Aldeia balanced: desenvolvimento completo com noble prep como endgame
        balanced: [
            { id: 'bal_eco_base',  label: 'Base Econômica',    reqs: { wood: 10, stone: 10, iron: 8 } },
            { id: 'bal_stable',    label: 'Estábulo',          reqs: { stable: 1 } },
            { id: 'bal_eco15',     label: 'Escala Econômica',  reqs: { wood: 15, stone: 15, iron: 15 } },
            { id: 'bal_market10',  label: 'Mercado Ativo',     reqs: { market: 10 } },
            { id: 'bal_eco20',     label: 'Minas Avançadas',   reqs: { wood: 20, stone: 20, iron: 18 } },
            { id: 'noble_prep',    label: 'Preparo Academia',  reqs: { main: 20, smith: 20, market: 10 } },
        ],
    };

    var FLAG_TYPE_MAP = {
        1: 'resource', 2: 'recruitment', 3: 'attack',
        4: 'defense', 5: 'luck', 6: 'population', 7: 'coin', 8: 'loot',
    };

    var CATEGORY_PRIORITY = {
        EARLY: { resource: 100, population: 80, recruitment: 60, attack: 50, defense: 40, loot: 30, luck: 20, coin: 10 },
        MID:   { attack: 100, loot: 90, recruitment: 80, resource: 70, population: 60, defense: 50, luck: 40, coin: 30 },
        LATE:  { attack: 100, loot: 95, coin: 80, recruitment: 70, resource: 60, population: 50, defense: 40, luck: 30 },
    };

    // Pesos por perfil de aldeia — decisor primário (fase atua como modulador secundário ±20%)
    var CATEGORY_PRIORITY_BY_PROFILE = {
        economic: { resource: 100, population: 85, loot: 55, recruitment: 35, attack: 25, defense: 20, luck: 10, coin: 15 },
        military: { attack: 100, recruitment: 95, loot: 85, defense: 55, resource: 40, population: 30, luck: 20, coin: 10 },
        support:  { defense: 100, population: 90, resource: 55, recruitment: 30, attack: 15, loot: 20, luck: 10, coin: 10 },
        balanced: { resource: 75, attack: 70, recruitment: 65, loot: 60, population: 60, defense: 50, luck: 20, coin: 10 },
    };

    // ============================================================
    // CUSTOS DE EDIFÍCIOS (BASE TW 10.x - AJUSTÁVEL POR MUNDO)
    // Formato: [madeira, pedra, ferro, tempo_segundos]
    // ============================================================
    // Custos base de edifícios: [madeira, pedra, ferro, tempo_segundos] no nível 1 (de 0→1).
    // Estes são PADRÕES e variam por mundo/versão. Sobrescreva via window.TWBot.setCostOverride()
    // ou GM_setValue('twbot_costs_override', JSON.stringify({barracks:[90,130,0,130], ...})).
    var TW_BUILDING_COSTS = {
        main:       [20, 40, 0, 60],
        barracks:   [80, 120, 0, 120],
        church:     [300, 500, 0, 300],
        watchtower: [150, 200, 0, 180],
        stable:     [200, 300, 150, 240],
        garage:     [400, 500, 300, 300],
        snob:       [60000, 60000, 60000, 3600],
        smith:      [100, 150, 50, 150],
        place:      [50, 100, 0, 90],
        statue:     [500, 500, 500, 600],
        market:     [100, 100, 50, 120],
        wood:       [50, 0, 0, 60],
        stone:      [0, 50, 0, 60],
        iron:       [0, 0, 50, 60],
        farm:       [70, 90, 0, 90],
        storage:    [100, 100, 0, 90],
        hide:       [150, 0, 100, 150],
        wall:       [100, 150, 0, 180]
    };
    (function _loadCostOverrides() {
        try {
            // Chave de contexto: mundo + mercado + idioma para calibração precisa
            var _wId    = (typeof game_data !== 'undefined' && game_data.world)
                ? game_data.world
                : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
            var _market = (typeof game_data !== 'undefined' && game_data.market) || 'unk';
            var _lang   = (document.documentElement.lang || navigator.language || 'unk').split('-')[0].toLowerCase();
            var _ctxKey = (_wId + '_' + _market + '_' + _lang).replace(/[^a-z0-9_]/gi, '_');

            // 1. Custos auto-calibrados por contexto (scraping DOM) — prioridade base
            var scrapedRaw = GM_getValue('twbot_costs_data_' + _ctxKey, null);
            if (scrapedRaw) {
                var scrapedData = typeof scrapedRaw === 'string' ? JSON.parse(scrapedRaw) : scrapedRaw;
                for (var bs in scrapedData) {
                    if (Array.isArray(scrapedData[bs])) TW_BUILDING_COSTS[bs] = scrapedData[bs];
                }
                log('[costs] Custos calibrados para contexto "' + _ctxKey + '" carregados', 'info');
            }

            // 2. Overrides manuais sobrescrevem tudo (maior prioridade)
            var raw = GM_getValue('twbot_costs_override', null);
            if (!raw) return;
            var overrides = typeof raw === 'string' ? JSON.parse(raw) : raw;
            var applied = [];
            for (var b in overrides) {
                if (Array.isArray(overrides[b]) && overrides[b].length >= 3) {
                    TW_BUILDING_COSTS[b] = overrides[b];
                    applied.push(b);
                }
            }
            if (applied.length) log('[costs] Overrides manuais aplicados: ' + applied.join(', '), 'info');
        } catch (e) { log('[costs] Erro ao carregar overrides: ' + e.message, 'warning'); }
    })();

    // Chave de contexto para calibração de custos por mundo + mercado + idioma
    function getCostContextKey(worldId) {
        var market = 'unk';
        var lang   = 'unk';
        try {
            market = (typeof game_data !== 'undefined' && game_data.market) || 'unk';
            lang   = (document.documentElement.lang || navigator.language || 'unk').split('-')[0].toLowerCase();
        } catch(e) {}
        return (worldId + '_' + market + '_' + lang).replace(/[^a-z0-9_]/gi, '_');
    }

    // Fatores de peso estratégico por fase e tipo de edifício
    const STRATEGIC_WEIGHT = {
        EARLY: { wood: 1.8, stone: 1.8, iron: 1.4, farm: 1.6, storage: 1.1, main: 0.7, barracks: 1.0, smith: 2.2, statue: 1.2, market: 1.7, stable: 2.0, wall: 0.4, place: 0.5, hide: 0.3, church: 0.3, watchtower: 0.3, garage: 0.2, snob: 0.1 },
        MID:   { wood: 1.0, stone: 1.0, iron: 1.1, farm: 1.1, storage: 1.0, main: 1.8, barracks: 1.1, smith: 1.2, statue: 1.0, market: 0.9, stable: 1.3, wall: 1.1, place: 0.6, hide: 0.5, church: 0.7, watchtower: 0.6, garage: 0.8, snob: 0.3 },
        LATE:  { wood: 0.8, stone: 0.8, iron: 1.2, farm: 0.9, storage: 0.9, main: 2.0, barracks: 1.0, smith: 1.3, statue: 1.1, market: 1.0, stable: 1.2, wall: 1.3, place: 0.7, hide: 0.6, church: 0.9, watchtower: 0.8, garage: 1.0, snob: 1.5 }
    };

    // Bônus do HQ como multiplicador de produtividade (acelera TODAS as construções)
    const HQ_PRODUCTIVITY_BONUS = {
        1: 0.04, 2: 0.08, 3: 0.12, 4: 0.16, 5: 0.21,  // +21% aos 5 — rush early agressivo
        6: 0.25, 7: 0.28, 8: 0.31, 9: 0.34, 10: 0.38, // +38% aos 10 (marco hq_mid)
        11: 0.41, 12: 0.44, 13: 0.47, 14: 0.50, 15: 0.53,
        16: 0.55, 17: 0.57, 18: 0.59, 19: 0.61, 20: 0.63,
        21: 0.65, 22: 0.67, 23: 0.68, 24: 0.69, 25: 0.70  // +70% no máximo
    };

    // Perfis de jogador (configurável via GM_setValue)
    const PLAYER_PROFILES = {
        balanced: { resource: 1.0, military: 1.0, defense: 1.0, expansion: 0.8 },
        raider:   { resource: 0.7, military: 1.5, defense: 0.6, expansion: 1.2 },
        defender: { resource: 0.9, military: 0.8, defense: 1.5, expansion: 0.5 },
        farmer:   { resource: 1.4, military: 0.6, defense: 0.7, expansion: 0.8 },
        noble:    { resource: 1.1, military: 1.2, defense: 0.9, expansion: 1.5 }
    };

    // ============================================================
    // SISTEMA DE MEMÓRIA E ANTI-LOOP POR ALDEIA
    // ============================================================
    var VillageMemory = {
        // Chaves de persistência por villageId
        KEYS: {
            lastTarget: 'village_last_target_',
            lastSuccess: 'village_last_success_',
            lastError: 'village_last_error_',
            cooldownUntil: 'village_cooldown_until_',
            previousBottleneck: 'village_prev_bottleneck_',
            currentMilestone: 'village_current_milestone_',
            consecutiveFails: 'village_consecutive_fails_',
            blockedTargets: 'village_blocked_targets_',
            actionLock: 'village_action_lock_',
            villageProfile: 'village_profile_'
        },

        // Duração dos cooldowns em ms
        COOLDOWNS: {
            BUILD_FAIL: 300000,      // 5 minutos após falha de construção
            TARGET_BLOCK: 600000,    // 10 minutos para targets problemáticos
            ACTION_LOCK: 30000,      // 30 segundos — TTL de segurança do lock (expira sozinho após crash/reload)
            SOFT_RESET: 1800000      // 30 minutos para reset suave
        },

        // Perfis de aldeia
        PROFILES: {
            ECONOMIC: 'economic',    // Foco em recursos e storage
            MILITARY: 'military',    // Foco em tropas e ofensiva
            SUPPORT: 'support',      // Foco em defesa e suporte
            BALANCED: 'balanced'     // Equilibrado
        },

        // Desserializa valor que pode ter sido salvo como JSON string
        _load: function(key, fallback) {
            var v = GM_getValue(key, null);
            if (v === null || v === undefined) return fallback;
            if (typeof v === 'string') {
                try { return JSON.parse(v); } catch (e) { return fallback; }
            }
            return v;
        },

        // Obter memória completa de uma aldeia
        get: function(villageId) {
            var lockVal = GM_getValue(this.KEYS.actionLock + villageId, 0);
            return {
                lastTarget:          GM_getValue(this.KEYS.lastTarget          + villageId, null),
                lastSuccess:         GM_getValue(this.KEYS.lastSuccess         + villageId, null),
                lastError:           this._load(this.KEYS.lastError            + villageId, null),
                cooldownUntil:       GM_getValue(this.KEYS.cooldownUntil       + villageId, 0),
                previousBottleneck:  GM_getValue(this.KEYS.previousBottleneck  + villageId, null),
                currentMilestone:    GM_getValue(this.KEYS.currentMilestone    + villageId, null),
                consecutiveFails:    GM_getValue(this.KEYS.consecutiveFails    + villageId, 0),
                blockedTargets:      this._load(this.KEYS.blockedTargets        + villageId, {}),
                // actionLock armazena timestamp de expiração (0 = livre)
                actionLock:          (typeof lockVal === 'number' ? lockVal : (lockVal ? Date.now() + VillageMemory.COOLDOWNS.ACTION_LOCK : 0)),
                profile:             GM_getValue(this.KEYS.villageProfile      + villageId, this.PROFILES.BALANCED)
            };
        },

        // Definir perfil da aldeia
        setProfile: function(villageId, profile) {
            if (this.PROFILES[profile.toUpperCase()]) {
                this.set(villageId, 'villageProfile', this.PROFILES[profile.toUpperCase()]);
                log('[memória] Perfil definido: ' + profile, 'info');
            }
        },

        // Obter pesos estratégicos baseados no perfil da aldeia
        getStrategyWeights: function(villageId) {
            var mem = this.get(villageId);
            var profile = mem.profile || this.PROFILES.BALANCED;

            // Pesos por tipo de edifício para cada perfil
            var weights = {
                economic:  { wood: 1.5, stone: 1.5, iron: 1.4, storage: 1.3, farm: 1.2, main: 1.1, barracks: 0.6, stable: 0.5, smith: 0.7, wall: 0.5, place: 0.4, hide: 0.3, church: 0.3, statue: 0.8, market: 1.2, garage: 0.3, snob: 0.4 },
                military:  { wood: 0.8, stone: 0.8, iron: 1.3, storage: 0.9, farm: 1.4, main: 1.0, barracks: 1.5, stable: 1.4, smith: 1.3, wall: 1.1, place: 0.6, hide: 0.4, church: 0.3, statue: 1.0, market: 0.5, garage: 0.8, snob: 0.6 },
                support:   { wood: 0.9, stone: 0.9, iron: 1.0, storage: 1.0, farm: 1.1, main: 1.0, barracks: 0.8, stable: 0.7, smith: 0.9, wall: 1.5, place: 0.5, hide: 0.6, church: 1.2, statue: 1.1, market: 0.7, garage: 0.5, snob: 0.3 },
                balanced:  { wood: 1.2, stone: 1.2, iron: 1.1, storage: 1.0, farm: 1.2, main: 1.3, barracks: 1.0, stable: 0.9, smith: 1.0, wall: 0.9, place: 0.5, hide: 0.4, church: 0.5, statue: 0.9, market: 0.7, garage: 0.6, snob: 0.5 }
            };

            return weights[profile] || weights.balanced;
        },

        // Atualizar campo específico
        set: function(villageId, field, value) {
            var key = this.KEYS[field] + villageId;
            // Serialização explícita para compatibilidade com Greasemonkey/Violentmonkey
            var toStore = (value !== null && typeof value === 'object') ? JSON.stringify(value) : value;
            GM_setValue(key, toStore);
        },

        // Registrar ação bem-sucedida
        recordSuccess: function(villageId, target) {
            this.set(villageId, 'lastTarget', target);
            this.set(villageId, 'lastSuccess', Date.now());
            this.set(villageId, 'consecutiveFails', 0);
            this.set(villageId, 'actionLock', false);
            log('[memória] Sucesso: ' + target, 'success');
        },

        // Registrar falha
        recordError: function(villageId, target, errorType) {
            var mem = this.get(villageId);
            this.set(villageId, 'lastError', { target: target, type: errorType, time: Date.now() });
            this.set(villageId, 'actionLock', false);

            // no_resources = recursos insuficientes, não é falha real do servidor — não bloqueia target
            if (errorType === 'no_resources') return;

            var fails = (mem.consecutiveFails || 0) + 1;
            this.set(villageId, 'consecutiveFails', fails);
            this.set(villageId, 'cooldownUntil', Date.now() + this.COOLDOWNS.BUILD_FAIL);

            if (fails >= 2 && target) {
                this.blockTarget(villageId, target, this.COOLDOWNS.TARGET_BLOCK);
            }

            log('[memória] Erro: ' + target + ' (falhas: ' + fails + ')', 'error');
        },

        // Bloquear target temporariamente
        blockTarget: function(villageId, target, duration) {
            var mem = this.get(villageId);
            var blocked = mem.blockedTargets || {};
            blocked[target] = Date.now() + (duration || this.COOLDOWNS.TARGET_BLOCK);
            this.set(villageId, 'blockedTargets', blocked);
            log('[memória] Target bloqueado: ' + target, 'warning');
        },

        // Limpar bloqueios e contagem de falhas (use no console ou ao detectar falso positivo)
        resetBlockedTargets: function(villageId) {
            GM_setValue('village_blocked_targets_' + villageId, '{}');
            GM_setValue('village_consecutive_fails_' + villageId, 0);
            log('[memória] Bloqueios e falhas resetados para aldeia ' + villageId, 'success');
        },

        // Verificar se target está bloqueado
        isTargetBlocked: function(villageId, target) {
            var mem = this.get(villageId);
            var blocked = mem.blockedTargets || {};
            if (blocked[target] && Date.now() < blocked[target]) {
                return true;
            }
            // Limpar expirados — usa cópia para comparação correta de tamanho
            var originalLength = Object.keys(blocked).length;
            for (var t in blocked) {
                if (Date.now() >= blocked[t]) {
                    delete blocked[t];
                }
            }
            if (Object.keys(blocked).length < originalLength) {
                this.set(villageId, 'blockedTargets', blocked);
            }
            return false;
        },

        // Verificar se pode executar ação (actionLock com TTL + cooldown)
        canAct: function(villageId) {
            var mem = this.get(villageId);
            var now = Date.now();

            // actionLock é um timestamp de expiração: 0 = livre, >now = travado
            if (mem.actionLock && now < mem.actionLock) {
                log('[memória] ActionLock ativo por mais ' + Math.round((mem.actionLock - now)/1000) + 's', 'warning');
                return false;
            }

            // Lock expirado — limpa automaticamente (proteção contra travamento por reload)
            if (mem.actionLock && now >= mem.actionLock) {
                GM_setValue(this.KEYS.actionLock + villageId, 0);
            }

            // Verificar cooldown global
            if (mem.cooldownUntil && now < mem.cooldownUntil) {
                log('[memória] Em cooldown por ' + Math.round((mem.cooldownUntil - now)/1000) + 's', 'warning');
                return false;
            }

            return true;
        },

        // Adquirir lock de ação (TTL = COOLDOWNS.ACTION_LOCK — expira sozinho se a página recarregar)
        acquireLock: function(villageId) {
            if (this.canAct(villageId)) {
                GM_setValue(this.KEYS.actionLock + villageId, Date.now() + this.COOLDOWNS.ACTION_LOCK);
                return true;
            }
            return false;
        },

        // Liberar lock de ação
        releaseLock: function(villageId) {
            GM_setValue(this.KEYS.actionLock + villageId, 0);
        },

        // Verificar se deve mudar de estratégia (muitas falhas)
        needsStrategyChange: function(villageId) {
            var mem = this.get(villageId);
            return (mem.consecutiveFails || 0) >= 3;
        },

        // Reset suave após período longo sem sucesso
        softReset: function(villageId) {
            var mem = this.get(villageId);
            if (mem.lastSuccess && Date.now() - mem.lastSuccess > this.COOLDOWNS.SOFT_RESET) {
                this.set(villageId, 'consecutiveFails', 0);
                this.set(villageId, 'blockedTargets', {});
                this.set(villageId, 'cooldownUntil', 0);
                // FIX: atualiza lastSuccess para evitar re-trigger a cada ciclo (loop infinito)
                this.set(villageId, 'lastSuccess', Date.now());
                log('[memória] Soft reset aplicado', 'warning');
                return true;
            }
            return false;
        }
    };

    // ============================================================
    // UTILS
    // ============================================================
    function log(msg, type) {
        if (!CONFIG.debug) return;
        type = type || 'info';
        var styles = { error: 'color:#ff4444', success: 'color:#00cc00', warning: 'color:#f39c12', info: 'color:#0088ff' };
        console.log('%c[TWBot ' + new Date().toLocaleTimeString() + '] ' + msg, styles[type] || styles.info);
        GM_log(msg);
    }

    function getScreenParam() { return new URL(window.location.href).searchParams.get('screen') || ''; }
    function getVillageIdParam() {
        var id = new URL(window.location.href).searchParams.get('village');
        return (id && /^\d+$/.test(id)) ? id : null;
    }
    function getVillagePoints() {
        try { return parseInt((typeof game_data !== 'undefined' && game_data.village && game_data.village.points) || 0) || 0; } catch (e) { return 0; }
    }
    function getGamePhase(pts) { return pts < 500 ? 'EARLY' : pts < 5000 ? 'MID' : 'LATE'; }
    function getCurrentVillageId() {
        return getVillageIdParam()
            || (typeof game_data !== 'undefined' && game_data.village && game_data.village.id
                ? String(game_data.village.id)
                : null);
    }
    // Canonicaliza qualquer forma de ID (número, string, undefined) para string numérica ou null.
    // Todas as funções públicas devem chamar isso na entrada.
    function normalizeVillageId(id) {
        if (id === null || id === undefined || id === '') return null;
        var s = String(id).trim();
        return /^\d+$/.test(s) ? s : null;
    }

    // ============================================================
    // HTTP - APENAS PARA OPERAÇÕES LOCAIS DO JOGO
    // SEM CHAMADAS EXTERNAS PARA IA
    // COM CACHE E RATE LIMITING PARA PERFORMANCE
    // ============================================================
    function gmGet(url, useCache) {
        // Verifica cache se habilitado
        if (useCache !== false) {
            var cached = RequestCache.get('gmGet:' + url);
            if (cached) {
                return Promise.resolve(cached);
            }
        }

        return RateLimiter.acquire().then(function() {
            return new Promise(function (resolve, reject) {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url.startsWith('http') ? url : window.location.origin + url,
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    onload: function (r) {
                        RateLimiter.release();
                        if (useCache !== false) {
                            RequestCache.set('gmGet:' + url, r.responseText);
                        }
                        resolve(r.responseText);
                    },
                    onerror: function () {
                        RateLimiter.release();
                        reject(new Error('GET falhou: ' + url));
                    },
                });
            });
        });
    }

    function gmPost(url, data) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url.startsWith('http') ? url : window.location.origin + url,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: data,
                onload: function (r) { resolve(r.responseText); },
                onerror: function () { reject(new Error('POST falhou: ' + url)); },
            });
        });
    }

    // fetch nativo do navegador — usa as cookies da sessao sem restricoes de @connect
    // Com rate limiting (slot adquirido antes do disparo) e debounce por tempo real entre disparos
    var twFetchLastCall = 0;

    function twFetch(url, method, body, useCache) {
        // Verifica cache para GET requests (retorna imediatamente, sem consumir slot)
        if (method === 'GET' && useCache !== false) {
            var cached = RequestCache.get('twFetch:' + url + ':' + (body || ''));
            if (cached) return Promise.resolve(cached);
        }

        return RateLimiter.acquire().then(function() {
            // Debounce calculado no momento do disparo real (não no enfileiramento)
            var now = Date.now();
            var debounceNeeded = CONFIG.requestDebounceMs - (now - twFetchLastCall);
            twFetchLastCall = now;

            var win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            var opts = {
                method: method || 'GET',
                credentials: 'include',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'application/json, text/javascript, */*; q=0.01'
                },
            };
            if (body) {
                opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
                opts.body = body;
            }

            var dispatch = function() {
                return win.fetch(url, opts).then(function(r) {
                    return r.text().then(function(text) {
                        RateLimiter.release();
                        // Status 500 com redirect é resposta normal do TW para algumas ações AJAX
                        // (confirma execução e pede redirecionamento de tela) — não é erro fatal
                        if (r.status === 500 && text.indexOf('"redirect"') !== -1) {
                            return text;
                        }
                        if (method === 'GET' && useCache !== false && r.status === 200) {
                            RequestCache.set('twFetch:' + url + ':' + (body || ''), text);
                        }
                        return text;
                    }, function(textErr) {
                        RateLimiter.release();
                        throw textErr;
                    });
                }, function(fetchErr) {
                    RateLimiter.release();
                    log('[twFetch] ERRO: ' + fetchErr.message, 'error');
                    throw fetchErr;
                });
            };

            if (debounceNeeded > 0) {
                return new Promise(function(resolve) { setTimeout(resolve, debounceNeeded); }).then(dispatch);
            }
            return dispatch();
        });
    }

    // ============================================================
    // HUD PANEL - CAMADA 4 (PAINEL DE CONFIANÇA)
    // ============================================================
   // ============================================================
    // HUD PANEL - VISÃO GERENCIAL / EXPLICABILIDADE (CAMADA 4)
    // ============================================================
   // ============================================================
    // HUD PANEL - VISÃO GERENCIAL INTEGRADA (CAMADA 4)
    // ============================================================
    var HUD = {
        el: null, minimized: false,
        obsMode: GM_getValue('tw_obs_mode', false),
        obsReport: null,

        info: {
            fase: 'Calculando...',
            gargalo: 'Analisando...',
            meta: 'Sincronizando...',
            acao: 'Lendo sensores',
            motivo: 'Iniciando Camadas de decisão'
        },
        tasks: {
            flag: { label: 'Bandeira', status: 'idle', detail: '' },
            statue: { label: 'Estátua', status: 'idle', detail: '' },
            knight: { label: 'Paladino', status: 'idle', detail: '' },
            build_general: { label: 'Obras', status: 'idle', detail: '' }
        },

        toggleObsMode: function () {
            this.obsMode = !this.obsMode;
            CONFIG.observationMode = this.obsMode;
            GM_setValue('tw_obs_mode', this.obsMode);
            this._rerender();
        },

        showObsReport: function (report) {
            this.obsReport = report;
            this._rerender();
        },

        init: function () {
            if (this.el) this.el.remove();
            this.minimized = GM_getValue('tw_hud_min', false);
            var el = document.createElement('div');
            el.id = 'tw-bot-hud';
            el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#121417;color:#ecf0f1;border-radius:10px;font-family:sans-serif;font-size:12px;z-index:99999;box-shadow:0 0 25px rgba(0,0,0,.9);border:1px solid #f39c12;min-width:290px;user-select:none;transition:all .3s;line-height:1.4;';
            el.innerHTML = this._html();
            document.body.appendChild(el);
            this.el = el;
            el.querySelector('#tw-hud-toggle').onclick = () => { this.minimized = !this.minimized; GM_setValue('tw_hud_min', this.minimized); this._rerender(); };
            el.querySelector('#tw-hud-obs-toggle').onclick = (e) => { e.stopPropagation(); this.toggleObsMode(); };
        },

        _html: function () {
            var obsBtnStyle = 'cursor:pointer;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:bold;margin-right:6px;'
                + (this.obsMode
                    ? 'background:#c0392b;color:#fff;'
                    : 'background:#2c3e50;color:#7f8c8d;');
            var obsBtn = '<span id="tw-hud-obs-toggle" style="' + obsBtnStyle + '">' + (this.obsMode ? '👁 OBS' : '▶ LIVE') + '</span>';
            var hdr = '<div id="tw-hud-toggle" style="padding:10px;cursor:pointer;color:#f39c12;font-weight:bold;background:#1a1c20;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;border-top-left-radius:10px;border-top-right-radius:10px;">'
                    + '<span>⚔️ Agente Gerencial TW</span>'
                    + '<div style="display:flex;align-items:center;">' + obsBtn + '<span>' + (this.minimized ? '[ + ]' : '[ — ]') + '</span></div>'
                    + '</div>';

            if (this.minimized) return hdr;

            var rows = '<div style="padding: 10px;">';

            // ── Bloco de Observação (quando modo ativo) ──
            if (this.obsMode) {
                var r = this.obsReport;
                rows += '<div style="background:#1a0505;padding:8px;border-radius:6px;margin-bottom:10px;border:1px solid #c0392b;">';
                rows += '<div style="font-size:11px;color:#e74c3c;font-weight:bold;margin-bottom:8px;">👁 MODO OBSERVAÇÃO — SEM EXECUÇÃO</div>';
                rows += this._buildDataRow('Fase:', this.info.fase, '#bdc3c7');
                rows += this._buildDataRow('Gargalo:', this.info.gargalo, '#e74c3c');
                rows += this._buildDataRow('Meta:', this.info.meta, '#3498db');
                if (r) {
                    rows += '<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #333;"></div>';
                    rows += this._buildDataRow('Próxima ação:', (r.alvo || '—') + (r.nivel ? ' Nv.' + r.nivel : ''), '#2ecc71');
                    var confColor = r.confianca >= 80 ? '#2ecc71' : r.confianca >= 60 ? '#f39c12' : '#e74c3c';
                    rows += '<div style="background:#2c3e50;border-radius:3px;height:5px;margin:5px 0;overflow:hidden;">'
                         +  '<div style="background:' + confColor + ';height:100%;width:' + r.confianca + '%;"></div></div>';
                    rows += '<div style="text-align:right;font-size:10px;color:' + confColor + ';margin-bottom:4px;">Confiança: ' + r.confianca + '%</div>';
                    if (r.alternativa) rows += this._buildDataRow('Alternativa:', r.alternativa + (r.altNivel ? ' Nv.' + r.altNivel : ''), '#7f8c8d');
                    rows += '<div style="background:#202225;padding:5px;border-radius:4px;font-family:monospace;font-size:10px;color:#a29bfe;margin-top:4px;">💡 ' + (r.razao || this.info.motivo) + '</div>';
                } else {
                    rows += '<div style="color:#7f8c8d;font-size:10px;margin-top:4px;">Aguardando próximo ciclo de análise...</div>';
                }
                rows += '</div>';
            } else {
                // ── Bloco Gerencial normal ──
                rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; margin-bottom:10px; border:1px solid #333;">';
                rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">📊 VISÃO ESTRATÉGICA</div>';
                rows += this._buildDataRow('Fase:', this.info.fase, '#bdc3c7');
                rows += this._buildDataRow('Gargalo:', this.info.gargalo, '#e74c3c');
                rows += '<div style="margin-top:6px; padding-top:6px; border-top:1px dashed #333;"></div>';
                rows += this._buildDataRow('Meta Atual:', this.info.meta, '#3498db');
                rows += this._buildDataRow('Alvo de Fila:', this.info.acao, '#2ecc71');
                rows += '<div style="background:#202225; padding:6px; border-radius:5px; font-family:monospace; font-size:10.5px; color:#a29bfe; margin-top:8px;">'
                     + '💡 <b>Razão:</b> ' + this.info.motivo
                     + '</div></div>';
            }

            // ── Bloco Operacional ──
            rows += '<div style="background:#1a1c20; padding:8px; border-radius:6px; border:1px solid #333;">';
            rows += '<div style="font-size:11px; color:#f39c12; font-weight:bold; margin-bottom:6px;">🔧 STATUS OPERACIONAL</div>';
            for (var taskId in this.tasks) {
                var task = this.tasks[taskId];
                var statusColor = this._getStatusColor(task.status);
                var statusIcon = this._getStatusIcon(task.status);
                rows += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; padding:4px; background:#202225; border-radius:4px;">';
                rows += '<span style="color:#bdc3c7; font-size:11px;">' + task.label + '</span>';
                rows += '<span style="color:' + statusColor + '; font-size:10px; font-weight:600;">' + statusIcon + ' ' + task.detail;
                rows += '</span></div>';
            }
            rows += '</div></div>';

            return hdr + rows;
        },

        _getStatusColor: function(status) {
            var colors = {
                'idle': '#95a5a6',
                'running': '#f39c12',
                'done': '#2ecc71',
                'error': '#e74c3c',
                'skip': '#3498db',
                'waiting': '#9b59b6'
            };
            return colors[status] || '#95a5a6';
        },

        _getStatusIcon: function(status) {
            var icons = {
                'idle': '⏸',
                'running': '⚙',
                'done': '✓',
                'error': '✗',
                'skip': '⊘',
                'waiting': '⏳'
            };
            return icons[status] || '⏸';
        },

        _buildDataRow: function(label, value, valColor) {
            return '<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><strong>' + label + '</strong><span style="color:' + valColor + '; font-weight:600; text-align:right;">' + value + '</span></div>';
        },

        _rerender: function () { if (this.el) this.el.innerHTML = this._html(); this.el.querySelector('#tw-hud-toggle').onclick = () => { this.minimized = !this.minimized; GM_setValue('tw_hud_min', this.minimized); this._rerender(); }; },

        // --- FUNÇÃO QUE ESTAVA FALTANDO (CORREÇÃO) ---
        addAudit: function(msg) {
            this.info.motivo = msg;
            this._rerender();
        },

        updateDiagnostics: function(fase, gargalo, meta, acao, motivo) {
            if (fase) this.info.fase = fase;
            if (gargalo) this.info.gargalo = gargalo;
            if (meta) this.info.meta = meta;
            if (acao) this.info.acao = acao;
            if (motivo) this.info.motivo = motivo;
            this._rerender();
        },

        set: function(id, status, detail) {
            // Atualiza status operacional da tarefa específica
            if (this.tasks[id]) {
                this.tasks[id].status = status || 'idle';
                this.tasks[id].detail = detail || '';
            }
            // Também atualiza o motivo geral para contexto
            if (detail) this.info.motivo = detail;
            this._rerender();
        }
    };
    // ============================================================
    // CSRF
    // ============================================================
    function extractCsrf(html) {
        var patterns = [
            /"csrf"\s*:\s*"([^"]{4,50})"/,
            /'csrf'\s*:\s*'([^']{4,50})'/,
            /[?&]h=([a-f0-9]{4,50})[&"'\s]/,
            /name="h"\s+value="([^"]{4,50})"/,
            /value="([a-f0-9]{4,50})"\s+name="h"/,
        ];
        for (var i = 0; i < patterns.length; i++) {
            var m = html.match(patterns[i]);
            if (m) return m[1];
        }
        try { if (typeof game_data !== 'undefined' && game_data.csrf) return game_data.csrf; } catch (e) {}
        return null;
    }

    // ============================================================
    // FLAG HELPERS
    // ============================================================
   function parseFlagsFromHtml(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var candidates = [];
        var seen = {};

        doc.querySelectorAll('.flag_box').forEach(function (box) {
            // Ignora explicitamente se estiver vazio no HTML
            if (box.classList.contains('flag_box_empty')) return;

            var type = null, level = null;
            var boxStyle = box.getAttribute('style') || '';
            var bm = boxStyle.match(/(\d+)_(\d+)\.(?:webp|png|gif|jpg)/);
            if (bm) { type = parseInt(bm[1]); level = parseInt(bm[2]); }

            if (!type || !level) return;

            // --- MELHORIA AQUI: CHECAGEM REAL DE QUANTIDADE ---
            var countEl = box.querySelector('.flag_count, .flag-count');
            var count = countEl ? parseInt(countEl.textContent.replace(/\D/g, '')) : 0;

            // Se o contador for 0 ou não existir, ignora
            if (count <= 0) return;

            var key = type + '_' + level;
            if (seen[key]) return;
            seen[key] = true;

            candidates.push({
                type: type, level: level, count: count,
                category: FLAG_TYPE_MAP[type] || 'unknown'
            });
        });

        log('[flags] Scanner: ' + candidates.length + ' bandeiras reais encontradas no inventário.');
        return candidates;
    }
    function isFlagAssignedInHtml(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var currentFlagBox = doc.querySelector('#current_flag, .flag_assigned');
        if (!currentFlagBox) return false;
        var style = currentFlagBox.getAttribute('style') || "";
        return style.indexOf('display:none') === -1 && style.indexOf('display: none') === -1;
    }
    function scoreFlagLocal(flag, phase) {
        return ((CATEGORY_PRIORITY[phase] || CATEGORY_PRIORITY.MID)[flag.category] || 0) + flag.level * 3;
    }

    function selectBestFlagLocal(flags, phase) {
        if (!flags.length) return null;
        return flags.slice().sort(function (a, b) { return scoreFlagLocal(b, phase) - scoreFlagLocal(a, phase); })[0];
    }

    // Scoring estratégico: perfil > fase > milestone > situação econômica
    // ctx: { profile, phase, milestoneId, taxaPop, riscoArmazem, recursosPercent }
    function scoreFlagStrategic(flag, ctx) {
        ctx = ctx || {};
        var profile = ctx.profile || 'balanced';
        var phase   = ctx.phase   || 'MID';

        // 1. Base: peso do perfil da aldeia
        var profileW = CATEGORY_PRIORITY_BY_PROFILE[profile] || CATEGORY_PRIORITY_BY_PROFILE.balanced;
        var score = profileW[flag.category] || 0;

        // 2. Modulação por fase (efeito secundário ±20%)
        var phaseW = CATEGORY_PRIORITY[phase] || CATEGORY_PRIORITY.MID;
        score = score * (0.80 + 0.20 * ((phaseW[flag.category] || 0) / 100));

        // 3. Bônus de nível (idêntico ao original)
        score += flag.level * 3;

        // 4. Alinhamento com milestone ativo
        var milId = ctx.milestoneId || '';
        if (milId) {
            if (/^(eco_base|eco_market|eco_scale|eco_advanced|hq_early|hq_mid)$/.test(milId)) {
                if (flag.category === 'resource')                                   score += 25;
            } else if (/^(mil_stable|mil_smith10|mil_barracks10|mil_full)$/.test(milId)) {
                if (flag.category === 'attack' || flag.category === 'recruitment') score += 30;
            } else if (/^(sup_wall10|sup_wall20|mil_wall)$/.test(milId)) {
                if (flag.category === 'defense')                                   score += 25;
            } else if (/^noble_prep$/.test(milId)) {
                if (flag.category === 'loot' || flag.category === 'resource')      score += 20;
            } else if (/^(unlock_statue|sup_church|sup_storage)$/.test(milId)) {
                if (flag.category === 'population')                                score += 15;
            }
        }

        // 5. Situação econômica
        if (flag.category === 'resource') {
            if (ctx.riscoArmazem) score -= 30; // overflow: mais produção é desperdício
            var pct = ctx.recursosPercent || {};
            var avgFill = ((pct.wood || 0) + (pct.stone || 0) + (pct.iron || 0)) / 3;
            if (avgFill > 0.85) score -= 20;   // storage muito cheio
            if (avgFill < 0.25) score += 20;   // storage vazio — recurso urgente
        }
        if (flag.category === 'population') {
            var taxaPop = ctx.taxaPop || 0;
            if (taxaPop >= 0.92)      score += 40; // pop crítica: desbloquear slots urgente
            else if (taxaPop >= 0.82) score += 20;
        }

        return score;
    }

    // ============================================================
    // BACKGROUND: ASSIGN FLAG via AJAX Fantasma
    // 1. Baixa HTML de screen=flags → parseia candidatas por identidade (URL da imagem)
    // 2. Ordena por prioridade de fase, tenta cada uma sequencialmente
    // 3. O servidor diz quem voce possui: erro = pula para proxima, sucesso = para
    // ============================================================
    function bgAssignFlagGhost(villageId, phase, ctx) {
        var origin   = window.location.origin;
        var flagsUrl = origin + '/game.php?village=' + villageId + '&screen=flags';
        log('[flag] Background: aldeia ' + villageId);
        HUD.set('flag', 'running', 'Carregando bandeiras...');

        return gmGet(flagsUrl).then(function (html) {
            if (isFlagAssignedInHtml(html)) {
                log('[flag] Background: bandeira ja atribuida — skip');
                return { ok: false, detail: 'ja_atribuida' };
            }

            var csrf = extractCsrf(html);
            try { if (!csrf && typeof game_data !== 'undefined' && game_data.csrf) csrf = game_data.csrf; } catch (e) {}
            if (!csrf) { log('[flag] Background: CSRF ausente!', 'error'); return { ok: false, detail: 'sem_csrf' }; }

            var candidates = parseFlagsFromHtml(html);
            if (!candidates.length) return { ok: false, detail: 'sem_bandeiras' };

            // Ordena por score estratégico (perfil + milestone + situação) e limita tentativas
            var ph = phase || 'MID';
            var _ctx = ctx ? Object.assign({ phase: ph }, ctx) : { phase: ph };
            var sorted = candidates.slice()
                .sort(function (a, b) { return scoreFlagStrategic(b, _ctx) - scoreFlagStrategic(a, _ctx); })
                .slice(0, 20);

            log('[flag] ' + sorted.length + ' candidatas ordenadas — tentando em sequencia...');

            var assignUrl = origin + '/game.php?village=' + villageId + '&screen=flags&ajaxaction=assign_flag';

            function tryNext(i) {
                if (i >= sorted.length) {
                    log('[flag] Nenhuma bandeira aceita pelo servidor', 'warning');
                    return Promise.resolve({ ok: false, detail: 'sem_bandeiras_validas' });
                }

                var flag   = sorted[i];
                var detail = (FLAG_TYPE_MAP[flag.type] || 'tipo ' + flag.type) + ' Nv.' + flag.level;
                var body   = 'flag_type=' + flag.type + '&level=' + flag.level + '&village_id=' + villageId + '&h=' + csrf;

                log('[flag] Tentando ' + detail + ' (' + (i + 1) + '/' + sorted.length + ')');
                HUD.set('flag', 'running', 'Tentando ' + detail + '...');

                return twFetch(assignUrl, 'POST', body).then(function (resp) {
                    var assigned = false;
                    var rawStr   = '';
                    try {
                        var json = JSON.parse(resp);
                        rawStr   = JSON.stringify(json).toLowerCase();
                        assigned = !!(json && (json.success || json.error === false || json.result === 'success' || json.flag));
                        log('[flag] Resposta ' + detail + ': ' + JSON.stringify(json).slice(0, 120));
                    } catch (e) {
                        rawStr   = resp.toLowerCase();
                        assigned = isFlagAssignedInHtml(resp);
                    }

                    if (assigned) {
                        log('[flag] Bandeira ativada: ' + detail, 'success');
                        return { ok: true, detail: detail };
                    }

                    // Servidor confirmou que nao temos essa bandeira → proxima
                    var notOwned = rawStr.indexOf('no tiene') !== -1 || rawStr.indexOf('not have') !== -1
                                || rawStr.indexOf('nao tem')  !== -1 || rawStr.indexOf('does not own') !== -1
                                || rawStr.indexOf('"error"')  !== -1;
                    log('[flag] ' + detail + (notOwned ? ' nao possui' : ' rejeitada') + ' — proxima...', 'warning');
                    return tryNext(i + 1);

                }).catch(function () { return tryNext(i + 1); });
            }

            return tryNext(0).then(function (result) {
                if (result.ok) return result;
                // Verificacao final na pagina
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        gmGet(flagsUrl).then(function (v) {
                            var verified = isFlagAssignedInHtml(v);
                            log('[flag] Verificacao final = ' + (verified ? 'ATIVADO' : 'FALHOU'), verified ? 'success' : 'error');
                            resolve({ ok: verified, detail: result.detail });
                        }).catch(function () { resolve(result); });
                    }, 1500);
                });
            });

        }).catch(function (e) {
            log('[flag] Background: erro = ' + (e.message || e), 'error');
            return { ok: false, detail: 'erro_rede' };
        });
    }

    // ============================================================
    // BACKGROUND: BUILD STATUE via AJAX puro
    // 1. POST ajaxaction=upgrade_building → enfileira construcao
    // 2. Extrai order ID do HTML atualizado
    // 3. GET ajaxaction=build_order_reduce → finaliza (se premium disponivel)
    // ============================================================
    function extractBuildOrderId(html) {
        var patterns = [
            /build_order_reduce[^"']*[?&]id=(\d+)/,
            /ajaxaction=build_order_reduce[^"]*id=(\d+)/,
            /"order_id"\s*:\s*(\d+)/,
            /buildorder.*?id=(\d+)/,
            /id=(\d+)&destroy=0/,
        ];
        for (var i = 0; i < patterns.length; i++) {
            var m = html.match(patterns[i]);
            if (m) return m[1];
        }
        return null;
    }

    function bgBuildStatue(villageId, csrf) {
        var origin  = window.location.origin;
        var mainUrl = origin + '/game.php?village=' + villageId + '&screen=main';
        log('[statue] Background AJAX: aldeia ' + villageId);
        HUD.set('statue', 'running', 'Verificando tela principal...');

        return gmGet(mainUrl).then(function (html) {
            var activeCsrf = csrf || extractCsrf(html);
            try { if (!activeCsrf && typeof game_data !== 'undefined' && game_data.csrf) activeCsrf = game_data.csrf; } catch (e) {}
            if (!activeCsrf) { log('[statue] CSRF ausente!', 'error'); return false; }

            // Verifica se ja esta em construcao
            var alreadyQueued = html.indexOf('statue') !== -1 && extractBuildOrderId(html);
            if (alreadyQueued) {
                log('[statue] Ja em fila de construcao' + (CONFIG.autoRushStatue ? ' — finalizando com ouro...' : ' — aguardando tempo normal.'));
                if (CONFIG.autoRushStatue) return tryFinish(alreadyQueued, activeCsrf);
                return true;
            }

            // POST para enfileirar a construcao
            var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
            var body     = 'id=statue&force=1&destroy=0&source=' + villageId + '&h=' + activeCsrf;

            log('[statue] POST upgrade_building...');
            HUD.set('statue', 'running', 'Enfileirando construcao...');

            return twFetch(buildUrl, 'POST', body).then(function (resp) {
                var queued = false;
                var orderId = null;
                try {
                    var json = JSON.parse(resp);
                    log('[statue] Resposta build: ' + JSON.stringify(json).slice(0, 150));
                    queued  = !!(json && (json.success || json.error === false || json.order_id || json.id));
                    orderId = json && (json.order_id || json.id);
                } catch (e) {
                    queued  = resp.indexOf('success') !== -1 || resp.indexOf('order') !== -1;
                    orderId = extractBuildOrderId(resp);
                }

                if (!queued && !orderId) {
                    // Reconfirma via GET da pagina: botao de estatua sumindo = sucesso
                    return gmGet(mainUrl).then(function (html2) {
                        var doc2  = new DOMParser().parseFromString(html2, 'text/html');
                        var noBtn = !doc2.querySelector('a.btn-build[data-building="statue"]');
                        if (noBtn) {
                            log('[statue] Enfileirada (botao sumiu da pagina).', 'success');
                            if (CONFIG.autoRushStatue) {
                                orderId = extractBuildOrderId(html2);
                                if (orderId) return tryFinish(orderId, activeCsrf);
                            }
                            return true;
                        }
                        log('[statue] Falha ao enfileirar.', 'error');
                        return false;
                    });
                }

                log('[statue] Enfileirada' + (orderId ? ' orderId=' + orderId : '') + '.', 'success');
                if (CONFIG.autoRushStatue && orderId) return tryFinish(orderId, activeCsrf);
                return true;
            });
        }).catch(function (e) {
            log('[statue] Erro: ' + (e.message || e), 'error');
            return false;
        });

        function tryFinish(orderId, activeCsrf) {
            var reduceUrl = origin + '/game.php?village=' + villageId
                + '&screen=main&ajaxaction=build_order_reduce&id=' + orderId + '&destroy=0&h=' + activeCsrf;
            log('[statue] GET build_order_reduce id=' + orderId + '...');
            HUD.set('statue', 'running', 'Finalizando construcao...');
            return twFetch(reduceUrl, 'GET').then(function (resp) {
                try {
                    var json = JSON.parse(resp);
                    log('[statue] Rush resposta: ' + JSON.stringify(json).slice(0, 100));
                } catch (e) {}
                log('[statue] Finalizacao concluida (ou ignorada sem premium).', 'success');
                return true;
            }).catch(function () { return true; });
        }
    }

    // ============================================================
    // BACKGROUND: KNIGHT — consulta de estado Rápida (ByPass) + AJAX
    // ============================================================
    function getKnightState(villageId) {

        // --- ⚡ FAST BYPASS: VERIFICAÇÃO VISUAL / VARIÁVEIS DO JOGO ---
        var knightAvistadoNativamente = false;
        try {
            // O jogo guarda tropas nesta div direita, em icones globais, ou na var "game_data"
            // Checamos a barra de pop, unidades, etc.
            var iconeNaBarraDireita = document.querySelector('a.unit_link[data-unit="knight"], .unit-item.knight');
            var contagemGlobal = document.querySelector('.knight_icon');

            if (iconeNaBarraDireita || contagemGlobal) {
                knightAvistadoNativamente = true;
            }
        } catch(e) {}

        // Se já viu com os próprios olhos ou está marcado na memória das ultimas horas
        if (knightAvistadoNativamente) {
            log('[knight] ⚡ Bypass Ativado: O Paladino está claramente visível na Aldeia/Painel. Busca de background cancelada!', 'success');
            return Promise.resolve({ canRecruit: false, isPresent: true, isRecruiting: false, csrf: null });
        }
        // --------------------------------------------------------------

        // O Bypass não achou (pode estar morto aguardando renascer ou em ataque).
        // Nesse caso, cai no "Plano B": puxar via requisição o histórico dele na estátua.
        var url = window.location.origin + '/game.php?village=' + villageId + '&screen=statue&_=' + Date.now();

        function parseKnightHtml(html) {
            // Criar documento virtual para análise
            var doc = new DOMParser().parseFromString(html, 'text/html');

            // Verificar se estátua existe e tem nível >= 1
            var statueLevelEl = doc.querySelector('.statue_level_1, .statue_level_2, .statue-built, [data-statue-level]');
            var statueExists = statueLevelEl !== null;

            // Verificar indicadores de recrutamento disponíveis
            var canRecruit = html.indexOf('knight_recruit_launch') !== -1 ||
                            html.indexOf('recruit_knight') !== -1 ||
                            doc.querySelector('.knight_recruit_launch, #knight_recruit_btn') !== null;

            // Verificar se está recrutando atualmente
            var isRecruit = !canRecruit && (html.indexOf('knight_recruit_rush') !== -1 ||
                                            html.indexOf('knight_progress') !== -1 ||
                                            html.indexOf('knight_recruiting') !== -1);

            // Verificar se paladino já está presente (vivo na aldeia)
            var hasKnight = !canRecruit && !isRecruit && (
                html.indexOf('rename_knight')  !== -1 ||
                html.indexOf('knight_present') !== -1 ||
                html.indexOf('Verplaatsen')    !== -1 ||
                doc.querySelector('#rename_knight, .knight_present, #knight_info') !== null
            );

            // Se estátua existe mas paladino não está presente e não está recrutando,
            // pode estar morto/ausente (pode recrutar novamente)
            if (statueExists && !hasKnight && !isRecruit && !canRecruit) {
                // Verificar se há botão de reviver/recrutar
                var reviveBtn = doc.querySelector('.revive_knight, .resurrect_knight, [href*="revive"]');
                if (reviveBtn) {
                    canRecruit = true;
                    log('[knight] Paladino ausente/morto - pronto para reviver', 'info');
                }
            }

            var csrf = extractCsrf(html);
            return { canRecruit: canRecruit, isPresent: hasKnight, isRecruiting: isRecruit, csrf: csrf, statueExists: statueExists, htmlPura: html };
        }

        return gmGet(url).then(parseKnightHtml).catch(function (e) {
            return twFetch(url, 'GET').then(parseKnightHtml);
        });
    }
    // ============================================================
    // BACKGROUND: RECRUIT KNIGHT via AJAX puro (sem iframe, sem DOM)
    // ============================================================
    function extractKnightIdExtremo(html) {
        var id = null;
        var doc = new DOMParser().parseFromString(html, 'text/html');

        // Pega O SEU BOTÃO específico!
        var btn = doc.querySelector('#knight_recruiting .knight_recruit_rush, .knight_recruit_rush');

        if (btn) {
            // 1. Tenta por atributos escondidos
            id = btn.getAttribute('data-knight') || btn.getAttribute('data-id') || btn.getAttribute('knight_id');

            // 2. Tenta caçar no href=?knight=4355
            if (!id) {
                var href = btn.getAttribute('href') || '';
                var mHref = href.match(/knight=(\d+)/i);
                if (mHref) id = mHref[1];
            }

            // 3. Tenta caçar no onclick="Knight.rush(4355)"
            if (!id) {
                var oc = btn.getAttribute('onclick') || '';
                var mOc = oc.match(/(\d{4,})/); // Paladinos geralmente tem ID acima de 1000
                if (mOc) id = mOc[1];
            }
        }

        // 4. Último caso: apela pro Regex varrendo a página inteira em busca desse ID maldito
        if (!id) {
            var match = html.match(/data-knight(?:-id)?=["'](\d+)/i) ||
                        html.match(/knight_id["']?\s*:\s*(\d+)/i) ||
                        html.match(/recruit_rush.*?knight=(\d+)/i) ||
                        html.match(/knight\s*=\s*['"]?(\d+)/i);
            if (match) id = match[1];
        }

        log('[knight] A extração encontrou o ID: ' + id);
        return id;
    }

    // ============================================================
    // BACKGROUND: RECRUIT KNIGHT (Bloqueio Inteligente de Limites)
    // ============================================================
   function bgRecruitKnight(villageId) {
        log('[knight] Verificando Paladino...');
        return getKnightState(villageId).then(function (state) {
            if (state.isPresent) return true;
            var recruitUrl = window.location.origin + '/game.php?village=' + villageId + '&screen=statue&ajaxaction=recruit';
            var _csrfFallback = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data)
                ? unsafeWindow.game_data.csrf
                : (typeof game_data !== 'undefined' && game_data ? game_data.csrf : '');
            var body = 'home=' + villageId + '&name=Paul&h=' + (state.csrf || _csrfFallback);

            return twFetch(recruitUrl, 'POST', body).then(function (resp) {
                var json = {};
                try { json = JSON.parse(resp); } catch(e){}

                if (json && json.error) {
                    log('[knight] BLOQUEIO: ' + json.error[0], 'warning');
                    // Bloqueia por 24 horas para evitar spam
                    GM_setValue('knight_blocked_' + villageId, Date.now() + (24 * 60 * 60 * 1000));
                    return false;
                }
                log('[knight] Recrutamento iniciado com sucesso!', 'success');
                return true;
            });
        });
    }
    // ============================================================
    // Polling pos-construcao: tenta finalizar estatua e recrutar paladino
    // Em cada ciclo tenta build_order_reduce (estatua) e recruit_rush (paladino)
    // O servidor aceita quando o botao verde esta disponivel (<5min), ignora caso contrario
    // ============================================================
    function pollForKnightAfterStatue(villageId) {
        var INTERVAL_MS  = 30000;
        var MAX_ATTEMPTS = 40;
        var attempts     = 0;
        var origin       = window.location.origin;

        log('[poll] Iniciando (30s/ciclo, max 20min)...');
        HUD.set('knight', 'running', 'Aguardando estatua...');

        return new Promise(function (resolve) {
            function next() { setTimeout(check, INTERVAL_MS); }

            function tryKnightRush(csrf) {
                var statueUrl = origin + '/game.php?village=' + villageId + '&screen=statue&_=' + Date.now();
                return gmGet(statueUrl).then(function (html) {
                    var patterns = [
                        /recruit_rush[^"']*knight=(\d+)/,
                        /knight=(\d+)/,
                        /"knight_id"\s*:\s*(\d+)/,
                        /"knight"\s*:\s*(\d+)/i,
                        /data-knight[="](\d+)/,
                    ];
                    var knightId = null;
                    for (var i = 0; i < patterns.length && !knightId; i++) {
                        var m = html.match(patterns[i]); if (m) knightId = m[1];
                    }
                    if (!knightId) { log('[poll] Knight ID nao encontrado — aguardando.', 'warning'); return false; }
                    log('[poll] Knight ID=' + knightId + ' — POST recruit_rush (gratis se <5min)...');
                    var rushUrl  = origin + '/game.php?village=' + villageId + '&screen=statue&ajaxaction=recruit_rush';
                    var rushBody = 'knight=' + knightId + '&home=' + villageId + '&h=' + csrf;
                    return twFetch(rushUrl, 'POST', rushBody).then(function (r) {
                        try { log('[poll] Rush resposta: ' + JSON.stringify(JSON.parse(r)).slice(0, 100)); } catch (e) {}
                        return true;
                    }).catch(function () { return false; });
                }).catch(function () { return false; });
            }

            function check() {
                attempts++;
                if (attempts > MAX_ATTEMPTS) {
                    log('[poll] Timeout 20min', 'warning');
                    HUD.set('knight', 'error', 'Timeout (20min)');
                    resolve(false); return;
                }

                var remaining = ((MAX_ATTEMPTS - attempts) * INTERVAL_MS / 60000).toFixed(0);
                log('[poll] Ciclo ' + attempts + '/' + MAX_ATTEMPTS);

                Promise.all([
                    gmGet(origin + '/game.php?village=' + villageId + '&screen=main').catch(function () { return ''; }),
                    getKnightState(villageId).catch(function () { return { canRecruit: false, isPresent: false, isRecruiting: false, csrf: null }; }),
                ]).then(function (res) {
                    var mainHtml   = res[0];
                    var knightInfo = res[1];
                    var csrf = knightInfo.csrf || extractCsrf(mainHtml);
                    try { if (!csrf && typeof game_data !== 'undefined' && game_data.csrf) csrf = game_data.csrf; } catch (e) {}

                    // Paladino ja presente
                    if (knightInfo.isPresent) {
                        log('[poll] Paladino presente!', 'success');
                        HUD.set('knight', 'done', 'Presente!');
                        resolve(true); return;
                    }

                    // Estatua pronta — recrutar agora
                    if (knightInfo.canRecruit) {
                        log('[poll] Estatua pronta — recrutando!', 'success');
                        HUD.set('knight', 'running', 'Recrutando paladino...');
                        bgRecruitKnight(villageId).then(function (ok) {
                            if (ok) {
                                // Verifica se ja esta presente ou ainda em recrutamento (rush pendente)
                                getKnightState(villageId).then(function (s2) {
                                    if (s2.isPresent) { HUD.set('knight', 'done', 'Recrutado!'); resolve(true); }
                                    else { log('[poll] Rush pendente — continuando ciclos...'); next(); }
                                }).catch(function () { HUD.set('knight', 'done', 'Recrutado!'); resolve(true); });
                            } else {
                                HUD.set('knight', 'error', 'Falhou');
                                resolve(false);
                            }
                        }).catch(function () { resolve(false); });
                        return;
                    }

                    // Paladino em recrutamento — tenta rush (gratis se botao verde)
                    if (knightInfo.isRecruiting && csrf) {
                        log('[poll] Paladino em recrutamento — tentando rush gratuito...');
                        HUD.set('knight', 'running', 'Tentando finalizar paladino... (~' + remaining + 'min)');
                        tryKnightRush(csrf).then(function () { next(); }).catch(next);
                        return;
                    }

                    // Estatua ainda construindo — tenta finalizar (gratis se botao verde)
                    var orderId = extractBuildOrderId(mainHtml);
                    if (orderId && csrf) {
                        log('[poll] Estatua construindo (id=' + orderId + ') — tentando finalizar...');
                        HUD.set('knight', 'running', 'Tentando finalizar estatua... (~' + remaining + 'min)');
                        var reduceUrl = origin + '/game.php?village=' + villageId
                            + '&screen=main&ajaxaction=build_order_reduce&id=' + orderId + '&destroy=0&h=' + csrf;
                        twFetch(reduceUrl, 'GET').then(function (r) {
                            try { log('[poll] Reduce: ' + JSON.stringify(JSON.parse(r)).slice(0, 80)); } catch (e) {}
                            next();
                        }).catch(next);
                        return;
                    }

                    HUD.set('knight', 'running', 'Aguardando... (~' + remaining + 'min)');
                    next();

                }).catch(function (e) {
                    log('[poll] Erro: ' + (e.message || e), 'error');
                    next();
                });
            }

            setTimeout(check, 5000);
        });
    }

    // ============================================================
    // CAMADA 1: COLETOR DE ESTADO E RAIO-X ABSOLUTO (SEM IA)
    // ============================================================
   // ============================================================
    // CAMADA 1: COLETOR DE ESTADO E RAIO-X ABSOLUTO (SEM IA)
    // ============================================================
    const TW_BUILDING_REQS = {
        main:       {},
        barracks:   { main: 3 },
        church:     { main: 5, farm: 5 },
        watchtower: { main: 5, farm: 5 },
        stable:     { main: 10, barracks: 5, smith: 5 },
        garage:     { main: 10, smith: 10 },
        snob:       { main: 20, smith: 20, market: 10 },
        smith:      { main: 5, barracks: 1 },
        place:      {},
        statue:     {},
        market:     { main: 3, storage: 2 },
        wood:       {},
        stone:      {},
        iron:       {},
        farm:       {},
        storage:    {},
        hide:       {},
        wall:       { barracks: 1 }
    };

    // ============================================================
    // CAMADA DE VALIDAÇÃO DE BUILD EXECUTÁVEL (V6.0)
    // Verifica robustez: recursos, botão, fila, sucesso real
    // ============================================================

    /**
     * Extrai candidatos de construção diretamente do DOM
     * Retorna lista de edifícios com botões disponíveis
     */
    function getBuildCandidatesFromDOM(mainDoc) {
        var candidates = [];
        // Buscar todos os edifícios na tela de main
        mainDoc.querySelectorAll('.building-item, .lit-item, [id*="building_"]').forEach(el => {
            var buildingId = el.id.replace('building_', '').replace('main_building_', '');
            var upgradeBtn = el.querySelector('.upgrade-button, .btn-upgrade, a[href*="ajaxaction=upgrade"]');
            if (upgradeBtn && buildingId) {
                candidates.push({
                    id: buildingId,
                    element: el,
                    button: upgradeBtn,
                    hasButton: true
                });
            }
        });
        return candidates;
    }

    /**
     * Extrai custos de um edifício específico do DOM ou usa tabela de custos
     * Prioriza leitura direta do HTML da página para precisão
     */
    function extractCosts(buildingId, mainDoc, fallbackCosts) {
        // 1. Linha canônica TW: #main_buildrow_{id}
        var row = mainDoc.querySelector('#main_buildrow_' + buildingId)
                || mainDoc.querySelector('tr[data-building="' + buildingId + '"]');

        if (row) {
            var tds = row.querySelectorAll('td');
            // TW layout: td[0]=nome td[1]=madeira td[2]=pedra td[3]=ferro td[4]=pop td[5]=tempo
            var parse = function(n) {
                var el = tds[n];
                if (!el) return 0;
                return parseInt((el.innerText || el.textContent || '').replace(/\./g, '').replace(/\D/g, '')) || 0;
            };
            var wood  = parse(1);
            var stone = parse(2);
            var iron  = parse(3);
            if (wood > 0 || stone > 0 || iron > 0) {
                return { wood: wood, stone: stone, iron: iron, fromDOM: true };
            }
        }

        // 2. Tooltip / elemento .costs
        var costEl = mainDoc.querySelector('#building_' + buildingId + ' .costs, .building-' + buildingId + ' .costs');
        if (costEl) {
            var text = costEl.textContent || costEl.innerText;
            var wood  = parseInt((text.match(/(\d[\d.]*)\s*(?:madeira|wood)/i)  || [])[1] || 0) || 0;
            var stone = parseInt((text.match(/(\d[\d.]*)\s*(?:pedra|stone)/i)   || [])[1] || 0) || 0;
            var iron  = parseInt((text.match(/(\d[\d.]*)\s*(?:ferro|iron)/i)    || [])[1] || 0) || 0;
            if (wood > 0 || stone > 0 || iron > 0) {
                return { wood: wood, stone: stone, iron: iron, fromDOM: true };
            }
        }

        // 3. Fallback: tabela estática TW_BUILDING_COSTS (sem fromDOM)
        if (fallbackCosts) {
            return { wood: fallbackCosts[0], stone: fallbackCosts[1], iron: fallbackCosts[2], time: fallbackCosts[3], fromDOM: false };
        }

        return null;
    }

    /**
     * Scraping automático de custos reais do mundo a partir do DOM de screen=main.
     * Chave de contexto: mundo + mercado + idioma. Revalida em 4 condições:
     * TTL 24h, mudança de contexto, confiança média < 40%, flag de revalidação forçada.
     * Overrides manuais (setCostOverride) nunca são sobrescritos.
     */
    function scrapeBuildingCostsFromDOM(mainDoc, villageLevels, worldId) {
        var ctxKey     = getCostContextKey(worldId);
        var SCRAPE_KEY = 'twbot_costs_scraped_' + ctxKey;
        var CONF_KEY   = 'twbot_cost_confidence_' + ctxKey;
        var DATA_KEY   = 'twbot_costs_data_' + ctxKey;
        var SCRAPE_TTL = 86400000; // 24 horas

        // Condição 1: contexto mudou (mundo, mercado ou idioma diferentes)
        var lastCtx    = GM_getValue('twbot_cost_context', '');
        var ctxChanged = lastCtx !== ctxKey;

        // Condição 2: confiança média abaixo do limiar (maioria dos custos veio de fallback estático)
        var conf = {};
        try { conf = JSON.parse(GM_getValue(CONF_KEY, null) || '{}'); } catch(e) {}
        var confKeys = Object.keys(conf);
        var avgConf  = confKeys.length > 0
            ? confKeys.reduce(function(s, k) { return s + (conf[k].score || 0); }, 0) / confKeys.length
            : 0;

        // Condição 3: flag de revalidação forçada (delta de custo detectado, mudança externa, etc.)
        var forceFlag = GM_getValue('twbot_force_rescrape', 0);

        var needsScrape = ctxChanged
            || forceFlag
            || (Date.now() - GM_getValue(SCRAPE_KEY, 0) >= SCRAPE_TTL)
            || (confKeys.length > 0 && avgConf < 40);

        if (!needsScrape) return;
        if (forceFlag) GM_setValue('twbot_force_rescrape', 0); // consumir flag

        var GROWTH_RES  = 1.5;
        var GROWTH_TIME = 1.1;
        var scraped = {};

        Object.keys(TW_BUILDING_COSTS).forEach(function(bId) {
            var currentLevel = parseInt(villageLevels[bId] || 0);
            if (currentLevel < 1) return;

            var row = mainDoc.querySelector(
                '#main_buildrow_' + bId + ', tr[data-building="' + bId + '"], tr#buildrow_' + bId
            );
            if (!row) return;

            var getCellNum = function(idx) {
                var cell = row.querySelector('td:nth-of-type(' + idx + ')');
                if (!cell) return 0;
                return parseInt((cell.textContent || '').trim().replace(/\./g, '').replace(/[^0-9]/g, '')) || 0;
            };

            var wood  = getCellNum(2);
            var stone = getCellNum(3);
            var iron  = getCellNum(4);
            if (wood <= 0 && stone <= 0 && iron <= 0) return;

            var timeSec = 0;
            for (var col = 5; col <= 7; col++) {
                var t = timeToSeconds(
                    ((row.querySelector('td:nth-of-type(' + col + ')') || {}).textContent || '').trim()
                );
                if (t > 0 && t < 86400) { timeSec = t; break; }
            }

            // Back-calcular custo base (nível 0→1) a partir do custo observado (nível L→L+1)
            var factor   = Math.pow(GROWTH_RES, currentLevel);
            var defaults = TW_BUILDING_COSTS[bId];
            var baseWood  = wood  > 0 ? Math.max(1, Math.round(wood  / factor)) : defaults[0];
            var baseStone = stone > 0 ? Math.max(1, Math.round(stone / factor)) : defaults[1];
            var baseIron  = iron  > 0 ? Math.max(0, Math.round(iron  / factor)) : defaults[2];
            var baseTime  = timeSec > 0 ? Math.max(10, Math.round(timeSec / Math.pow(GROWTH_TIME, currentLevel))) : defaults[3];

            var sane = function(calc, def) { if (def <= 0) return true; var r = calc / def; return r >= 0.1 && r <= 5.0; };
            if (!sane(baseWood, defaults[0]) || !sane(baseStone, defaults[1]) || !sane(baseIron, defaults[2])) {
                log('[costs-scraper] ' + bId + ': base fora do range, ignorado', 'debug');
                return;
            }

            scraped[bId] = [baseWood, baseStone, baseIron, baseTime];
            log('[costs-scraper] ' + bId + ' nv' + currentLevel + ': obs W=' + wood + '/S=' + stone + '/I=' + iron + '/T=' + timeSec + 's → base=[' + [baseWood, baseStone, baseIron, baseTime].join(',') + ']', 'debug');
        });

        var count = Object.keys(scraped).length;
        if (count === 0) {
            log('[costs-scraper] Nenhum custo extraído do DOM (estrutura não reconhecida)', 'warn');
            return;
        }

        // Mesclar com overrides manuais sem sobrescrever entradas manuais
        var stored = {};
        try {
            var raw = GM_getValue('twbot_costs_override', null);
            stored = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch(e) {}
        for (var b in scraped) {
            if (!stored[b]) {
                stored[b] = scraped[b];
                TW_BUILDING_COSTS[b] = scraped[b];
            }
        }

        // Atualizar confidence scores: cada hit do DOM aumenta confiança (+15, máx. 100)
        for (var bc in scraped) {
            if (!conf[bc]) conf[bc] = { score: 0, hits: 0, source: 'dom', ts: 0 };
            conf[bc].score  = Math.min(100, conf[bc].score + 15);
            conf[bc].hits++;
            conf[bc].source = 'dom';
            conf[bc].ts     = Date.now();
        }

        GM_setValue(DATA_KEY,  JSON.stringify(scraped));  // custos calibrados por contexto
        GM_setValue(CONF_KEY,  JSON.stringify(conf));      // confidence scores por edifício
        GM_setValue(SCRAPE_KEY, Date.now());
        GM_setValue('twbot_cost_context', ctxKey);        // registrar contexto atual
        log('[costs-scraper] ' + count + ' custos calibrados para contexto "' + ctxKey + '" | conf. média: ' + Math.round(avgConf) + '%', 'success');
    }

    /**
     * Verifica se há recursos suficientes AGORA para construir
     * Usa margem de tolerância de 15% para compensar erros de parsing do DOM
     */
    function hasEnoughResources(buildingId, state, costs) {
        if (!costs) {
            log('[Recursos] Não foi possível ler custos para ' + buildingId + ', assumindo disponível.', 'warn');
            return true; // Fail-safe: se não conseguir ler, permite tentativa
        }

        var currentWood = state.recursos.wood || 0;
        var currentStone = state.recursos.stone || 0;
        var currentIron = state.recursos.iron || 0;

        // Margem de tolerância de 15% para erros de leitura de DOM vs realidade
        var tolerance = 0.85;

        var enough = (currentWood >= ((costs.wood || 0) * tolerance)) &&
                     (currentStone >= ((costs.stone || 0) * tolerance)) &&
                     (currentIron >= ((costs.iron || 0) * tolerance));

        return enough;
    }

    /**
     * Verifica se o botão de upgrade está disponível e clicável
     */
    /**
     * Verifica se o botão de construção está disponível no DOM
     * Agora com detecção aprimorada de edifícios já construídos/em construção
     */
    // Verifica se um edifício pode ser construído agora com base no HTML do screen=main.
    // TW usa type=main para TODOS os edifícios — o ID vai no POST body (id=building).
    // Botões são JS-rendered: nunca há <a href> com ajaxaction no HTML bruto.
    // Portanto a detecção baseia-se na LINHA DA TABELA #main_buildrow_{id}.
    function isButtonAvailable(buildingId, mainDoc) {
        // --- 1. Linha canônica TW: #main_buildrow_{building} ---
        var buildRow = mainDoc.querySelector('#main_buildrow_' + buildingId);
        if (buildRow) {
            if (buildRow.style.display === 'none' || buildRow.classList.contains('hidden')) return false;
            var timerEl = buildRow.querySelector('.timer, .countdown, [id*="timer_"]');
            if (timerEl && timerEl.textContent.trim()) return false;
            var maxEl = buildRow.querySelector('.max-level, .level_max, .all, [data-max-level], .upgrade-button.all');
            if (maxEl) return false;
            return true;
        }

        // --- 2. Seletores alternativos: #main_buildlink_{building} ---
        var buildLink = mainDoc.querySelector(
            '#main_buildlink_' + buildingId + ':not(.inactive):not(.disabled),' +
            '#' + buildingId + '_buildlink:not(.inactive):not(.disabled),' +
            'a[id*="buildlink_' + buildingId + '"]:not(.disabled)'
        );
        if (buildLink && !buildLink.hasAttribute('disabled')) return true;

        // --- 3. Upgrade link com type=main (formato real do TW) ---
        var upgradeLinks = mainDoc.querySelectorAll('a[href*="ajaxaction=upgrade_building"]');
        if (upgradeLinks.length > 0) {
            for (var j = 0; j < upgradeLinks.length; j++) {
                var lnk = upgradeLinks[j];
                if (!lnk.classList.contains('disabled') && !lnk.hasAttribute('disabled')) return true;
            }
        }

        // --- 4. Estátua: estrutura própria ---
        if (buildingId === 'statue') {
            if (mainDoc.querySelector('.statue_level_1, .statue_level_2, .statue-built, [data-statue-level]')) return false;
            if (mainDoc.querySelector('.statue-slot-empty, .statue_empty, .empty_statue_slot')) return true;
        }

        return false;
    }

    /**
     * Verifica se a construção entrou na fila após solicitação
     * Usado para validar sucesso real da ação
     */
    function verifyQueuedAfterBuild(responseText, buildingId) {
        try {
            var json = JSON.parse(responseText);
            // Verificar sucesso explícito
            if (json.success === true || json.order_id) {
                log('[verificação] ' + buildingId + ' entrou na fila com sucesso! OrderID: ' + (json.order_id || 'N/A'), 'success');
                return true;
            }
            // Verificar mensagens de erro comuns
            if (json.error) {
                log('[verificação] Erro ao construir ' + buildingId + ': ' + json.error, 'error');
                return false;
            }
            // Verificar se há indicador de "já em construção"
            if (json.already_queued || json.building_in_progress) {
                log('[verificação] ' + buildingId + ' já está em construção', 'info');
                return true; // Considera sucesso pois já está na fila
            }
        } catch (e) {
            // Fallback: buscar indicadores textuais de sucesso
            if (responseText.indexOf('success') !== -1 ||
                responseText.indexOf('order_id') !== -1 ||
                responseText.indexOf('queued') !== -1 ||
                responseText.indexOf('building_upgraded') !== -1) {
                return true;
            }
            // Verificar se não há erros evidentes
            if (responseText.indexOf('error') !== -1 ||
                responseText.indexOf('failed') !== -1 ||
                responseText.indexOf('not enough resources') !== -1) {
                log('[verificação] Erro detectado na resposta para ' + buildingId, 'error');
                return false;
            }
        }
        // Se chegou aqui sem indicação clara de erro, assume que pode ter funcionado
        // (alguns servidores retornam HTML parcial em vez de JSON)
        log('[verificação] Resposta ambígua para ' + buildingId + ', verificando conteúdo...', 'warning');
        return responseText.length > 50; // Se tem conteúdo razoável, assume sucesso
    }

    /**
     * Validação completa de build executável
     * Combina todas as verificações: pré-requisitos, recursos, botão, fila
     */
    function isBuildExecutable(buildingId, state, mainDoc) {
        // 1. Pré-requisitos básicos
        if (!state.podeSerConstruido[buildingId]) return false;

        // 2. Verificar se botão está disponível no DOM
        if (!isButtonAvailable(buildingId, mainDoc)) return false;

        // 3. Extrair custos (priorizar DOM, fallback tabela)
        var baseCosts = TW_BUILDING_COSTS[buildingId];
        var nivelAtual = parseInt(state.niveis[buildingId] || 0);
        var costs = extractCosts(buildingId, mainDoc, baseCosts);

        if (!costs) return false;

        // Aplicar progressão de nível se veio da tabela
        if (!costs.fromDOM && baseCosts) {
            costs.wood = Math.floor(baseCosts[0] * Math.pow(1.5, nivelAtual));
            costs.stone = Math.floor(baseCosts[1] * Math.pow(1.5, nivelAtual));
            costs.iron = Math.floor(baseCosts[2] * Math.pow(1.5, nivelAtual));
            costs.time = Math.floor(baseCosts[3] * Math.pow(1.1, nivelAtual));
        }

        // 4. Verificar recursos suficientes
        if (!hasEnoughResources(buildingId, state, costs)) {
            return false;
        }

        // 5. Verificar se há vaga na fila
        var maxFila = (state.premium && state.premium.ativo) ? 5 : 2;
        if (state.filaBuilds >= maxFila) return false;

        return true;
    }

   function timeToSeconds(timeStr) {
        if (!timeStr) return 9999;
        var parts = timeStr.replace(/[^\d:]/g, '').split(':').map(Number);
        if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        if (parts.length === 2) return (parts[0] * 60) + parts[1];
        return 9999;
    }

    function collectVillageState(villageId) {
        // Garante que erros síncronos (ex.: game_data nulo) rejeitem a Promise
        // em vez de lançar antes do encadeamento .then/.catch do chamador
        try {
            return _collectVillageStateImpl(villageId);
        } catch (e) {
            log('[collectVillageState] Erro síncrono: ' + e.message, 'error');
            return Promise.reject(e);
        }
    }

    function _collectVillageStateImpl(villageId) {
        var origin = window.location.origin;
        var safeStr = function (p) { return p.catch(function() { return ''; }); };
        var statueEnabled = false;
        try {
            statueEnabled = typeof game_data !== 'undefined'
                && game_data !== null
                && game_data.village != null
                && game_data.village.buildings != null
                && game_data.village.buildings.statue !== undefined;
        } catch (e) { statueEnabled = false; }

        // Limpar cache expirado antes de coletar novo estado
        RequestCache.cleanup();

        // Buscar dados adicionais para previsão de overflow (loot e rewards)
        // Nota: Em versão futura, buscar screen=overview_v para ataques em andamento
        // e screen=place para quests/tasks ativas

        // Quest popup: busca no máximo uma vez a cada 5 minutos por aldeia
        var QUEST_TTL  = 300000;
        var questTsKey = 'twbot_quest_ts_' + villageId;
        var fetchQuest = (Date.now() - GM_getValue(questTsKey, 0)) > QUEST_TTL;
        if (fetchQuest) GM_setValue(questTsKey, Date.now());
        var questUrl = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=quest_popup&tab=main-tab&quest=0';

        // Usar cache para reduzir requisições redundantes
        return Promise.all([
            safeStr(gmGet(origin + '/game.php?village=' + villageId + '&screen=flags', true)),
            safeStr(gmGet(origin + '/game.php?village=' + villageId + '&screen=main', true)),
            statueEnabled ? getKnightState(villageId) : Promise.resolve({ canRecruit: false, isPresent: false, isRecruiting: false, statueExists: false }),
            fetchQuest ? safeStr(twFetch(questUrl, 'GET', null, false)) : Promise.resolve('')
        ]).then(function (results) {
            var flagsHtml = results[0], mainHtml = results[1], statueInfo = results[2], questHtml = results[3] || '';
            var mainDoc = new DOMParser().parseFromString(mainHtml, 'text/html');
            var rawData = typeof game_data !== 'undefined' ? game_data : {};

            // --- DETECÇÃO DE RUSH (Obras e Paladino) ---
            var rushCandidates = [];
            var buildQueueRows = mainDoc.querySelectorAll('#build_queue tr[id^="order_"], #build_queue tr, .buildqueue_container tr, tr[id^="order_"]');

            buildQueueRows.forEach((row, index) => {
                var timerEl = row.querySelector('.timer, .time_remaining, span[style*="color"]');
                if (!timerEl) return;
                var secondsLeft = timeToSeconds(timerEl.textContent.trim());
                if (secondsLeft > 0 && secondsLeft < (CONFIG.freeRushMinutes * 60 + 120)) {
                    var orderId = row.id.replace('order_', '');
                    var idLink  = row.querySelector('a[href*="id="')?.getAttribute('href') || '';
                    var m = idLink.match(/id=(\d+)/);
                    if (m && m[1]) {
                        rushCandidates.push(m[1]);
                        log('[rush] RUSH elegível: obra ID=' + m[1] + ' (' + secondsLeft + 's restantes)', 'success');
                    } else if (orderId && !isNaN(orderId)) {
                        rushCandidates.push(orderId);
                        log('[rush] RUSH elegível: obra ID=' + orderId + ' (' + secondsLeft + 's restantes)', 'success');
                    }
                }
            });

            var knightRushId = null;
            if (statueInfo.isRecruiting) {
                var mK = (statueInfo.htmlPura || '').match(/knight=(\d+)/) || (statueInfo.htmlPura || '').match(/data-knight=["'](\d+)/);
                if (mK) { knightRushId = mK[1]; log('[rush] Paladino elegível para rush ID=' + knightRushId, 'success'); }
            }

            // Estimar loot esperado baseado em recursos disponíveis para saque (simplificado)
            // Em versão completa, buscar attacks em andamento via overview_v
            var lootEstimadoSimples = (rawData.village.wood_float + rawData.village.stone_float + rawData.village.iron_float) * 0.1; // 10% dos recursos como estimativa de loot incoming

            // Estimar rewards de quests (simplificado - seria preenchido via API de quests)
            var rewardsQuestsEstimado = 0; // Placeholder para integração futura com quests

            // LER RECURSOS DIRETAMENTE DO DOM PARA PRECISÃO MÁXIMA
            var woodFromDOM = 0, stoneFromDOM = 0, ironFromDOM = 0;
            var woodEl = mainDoc.querySelector('#resource_span .wood, .res .wood, #resources .wood');
            var stoneEl = mainDoc.querySelector('#resource_span .stone, .res .stone, #resources .stone');
            var ironEl = mainDoc.querySelector('#resource_span .iron, .res .iron, #resources .iron');

            if (woodEl) {
                var woodText = woodEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                woodFromDOM = parseInt(woodText) || 0;
            }
            if (stoneEl) {
                var stoneText = stoneEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                stoneFromDOM = parseInt(stoneText) || 0;
            }
            if (ironEl) {
                var ironText = ironEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                ironFromDOM = parseInt(ironText) || 0;
            }

            // Usar valores do DOM se disponíveis e diferentes, senão usar rawData
            var finalWood = (woodFromDOM > 0) ? woodFromDOM : (parseFloat(rawData.village.wood_float) || 0);
            var finalStone = (stoneFromDOM > 0) ? stoneFromDOM : (parseFloat(rawData.village.stone_float) || 0);
            var finalIron = (ironFromDOM > 0) ? ironFromDOM : (parseFloat(rawData.village.iron_float) || 0);

            if (woodFromDOM > 0 || stoneFromDOM > 0 || ironFromDOM > 0) {
                log('[recursos] DOM: W=' + woodFromDOM + ' S=' + stoneFromDOM + ' I=' + ironFromDOM + ' | FINAL: W=' + Math.round(finalWood) + ' S=' + Math.round(finalStone) + ' I=' + Math.round(finalIron), 'debug');
            }

            // Calibrar custos reais do mundo automaticamente (uma vez por 24h por mundo)
            try {
                var _worldId = (rawData.world) || window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                scrapeBuildingCostsFromDOM(mainDoc, rawData.village.buildings || {}, _worldId);
            } catch(e) {
                log('[costs-scraper] Erro durante scraping: ' + e.message, 'warning');
            }

            var state = {
                villageId: villageId,
                csrf: rawData.csrf || extractCsrf(mainHtml),
                statueEnabled: statueEnabled,
                recursos: { wood: finalWood, stone: finalStone, iron: finalIron, max: rawData.village.storage_max },
                producao: { wood: (parseFloat(rawData.village.wood_prod)||0)*3600, stone: (parseFloat(rawData.village.stone_prod)||0)*3600, iron: (parseFloat(rawData.village.iron_prod)||0)*3600 },
                populacao: { current: parseInt(rawData.village.pop), max: parseInt(rawData.village.pop_max) },
                niveis: rawData.village.buildings,
                filaBuilds: mainDoc.querySelectorAll('.lit-item, #build_queue tr .timer').length,
                rushIds: rushCandidates,
                knightRushId: knightRushId,
                premium: { ativo: !!(rawData.features?.Premium?.active) },
                phase: getGamePhase(parseInt(rawData.village.points)),
                flags: parseFlagsFromHtml(flagsHtml),
                flagAssigned: isFlagAssignedInHtml(flagsHtml), // CORRIGIDO
                knight: statueInfo,
                podeSerConstruido: {},
                // Sistema proativo de previsão de overflow
                lootEsperado: lootEstimadoSimples,      // Estimativa baseada em recursos (futuro: attacks em andamento)
                rewardsEsperados: rewardsQuestsEstimado,
                // Recompensas de quests disponíveis (parseadas do popup, máx. 1×/5min)
                questRewards: parseQuestRewards(questHtml),
                // Dados brutos do DOM para validação executável
                _mainDoc: mainDoc,
                _mainHtml: mainHtml
            };

            for (var ed in TW_BUILDING_REQS) {
                var travado = false;
                for (var nec in TW_BUILDING_REQS[ed]) { if (parseInt(state.niveis[nec]||0) < TW_BUILDING_REQS[ed][nec]) { travado = true; break; } }
                state.podeSerConstruido[ed] = !travado;
            }

            // Extrair candidatos executáveis do DOM (validação robusta)
            state.buildCandidatesDOM = getBuildCandidatesFromDOM(mainDoc);

            return state;
        });
    }
function motorDeDecisaoMacro(state, villageId) {
        var tasks = [];
        var maxFila = (state.premium && state.premium.ativo) ? 5 : 2;

        // Carregar memória da aldeia
        var memory = VillageMemory.get(villageId);

        var visHUD = { fase: state.phase, gargalo: 'OK', meta: 'Calculando...', acao: 'Monitorando', motivo: 'Ativo' };

        // Verificar se deve mudar estratégia por falhas consecutivas
        if (VillageMemory.needsStrategyChange(villageId)) {
            log('[motorDeDecisao] Muitas falhas consecutivas, ajustando estratégia', 'warning');
            visHUD.gargalo = 'AJUSTE';
            visHUD.motivo = 'Falhas consecutivas detectadas';
        }

        // Obter pesos estratégicos baseados no perfil da aldeia (substitui profile do jogador)
        var profileWeights = VillageMemory.getStrategyWeights(villageId);

        // TRAVA GLOBAL DE HQ (Manual 2026) — avaliada uma vez, aplicada em todos os blocos
        // HQ só sobe além de nível 15 em EARLY depois que Estábulo E Ferreiro existirem (≥ 1)
        var _hqLvl     = parseInt(state.niveis['main']   || 0);
        var _stLvl     = parseInt(state.niveis['stable'] || 0);
        var _smLvl     = parseInt(state.niveis['smith']  || 0);
        var _HQ_LOCKED = (state.phase === 'EARLY' && _hqLvl >= 10 && (_stLvl < 1 || _smLvl < 1));
        if (_HQ_LOCKED) {
            log('[estratégia] HQ TRAVADO GLOBALMENTE (Nv.' + _hqLvl + '): aguardando Estábulo/Ferreiro', 'warning');
        }

        // 1. RUSH GRÁTIS (Sempre primeiro)
        var _rushIds = state.rushIds || [];
        if (_rushIds.length > 0) {
            log('[rush] ' + _rushIds.length + ' obra(s) para rush: [' + _rushIds.join(', ') + ']', 'success');
            _rushIds.forEach(id => tasks.push({ id: 'build_rush', action: 'DO', orderId: id }));
            visHUD.acao = "RUSH OBRA"; visHUD.motivo = "Limpando fila.";
            HUD.set('build_general', 'running', 'Finalizando obras');
            HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
            return Promise.resolve(tasks);
        }

        if (state.knightRushId) {
            log('[rush] Paladino para rush: ID=' + state.knightRushId, 'success');
            tasks.push({ id: 'knight_rush', action: 'DO', knightId: state.knightRushId });
            visHUD.acao = "RUSH PALADINO"; visHUD.motivo = "Finalizando herói!";
            HUD.set('knight', 'running', 'Recrutamento em rush');
            HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
            return Promise.resolve(tasks);
        }

        // 2. BANDEIRA (Se não houver nenhuma ativa)
        if (!state.flagAssigned) {
            var _flags = state.flags || [];
            // Contexto estratégico para scoring: perfil + milestone (ciclo anterior) + situação econômica
            var _flagPct = {
                wood:  state.recursos.wood  / (state.recursos.max || 1),
                stone: state.recursos.stone / (state.recursos.max || 1),
                iron:  state.recursos.iron  / (state.recursos.max || 1)
            };
            var _flagCtx = {
                profile:        memory.profile,
                phase:          state.phase,
                milestoneId:    memory.currentMilestone,
                taxaPop:        state.populacao.max > 0 ? state.populacao.current / state.populacao.max : 0,
                riscoArmazem:   _flagPct.wood > 0.90 || _flagPct.stone > 0.90 || _flagPct.iron > 0.90,
                recursosPercent: _flagPct
            };
            var best = _flags.slice().sort(function(a, b) {
                return scoreFlagStrategic(b, _flagCtx) - scoreFlagStrategic(a, _flagCtx);
            })[0];
            if (best) {
                tasks.push({ id: 'flag', action: 'DO', reason: "Ativando " + best.category, ctx: _flagCtx });
                visHUD.acao = "BANDEIRA";
                visHUD.motivo = "Flag: " + best.category + " [" + (memory.profile || 'balanced') + "]";
                HUD.set('flag', 'running', 'Selecionando categoria');
            } else {
                HUD.set('flag', 'idle', 'Sem bandeiras disponíveis');
            }
        } else {
            HUD.set('flag', 'done', 'Bandeira ativa');
        }

        // 3. PALADINO (Com trava de erro do servidor + memória)
        var pBlock = GM_getValue('knight_blocked_' + state.villageId, 0);

        // Verificar se estátua foi construída (nível >= 1) mas paladino ainda não está presente
        // Isso pode ocorrer quando estátua foi finalizada mas paladino morreu/foi expulso
        var _knight = state.knight || {};
        var statueBuilt = state.statueEnabled && _knight.statueExists;

        if (_knight.canRecruit && Date.now() > pBlock) {
            tasks.push({ id: 'knight', action: 'DO' });
            visHUD.acao = "RECRUTAR PALADINO";
            HUD.set('knight', 'running', 'Pronto para recrutar');
        } else if (_knight.isRecruiting) {
            HUD.set('knight', 'waiting', 'Recrutando...');
        } else if (!_knight.isPresent && !statueBuilt) {
            // Estátua ainda não foi construída
            HUD.set('knight', 'idle', 'Estátua não construída');
        } else if (!_knight.isPresent && statueBuilt) {
            if (Date.now() > pBlock) {
                tasks.push({ id: 'knight', action: 'DO' });
                visHUD.acao = "REVIVER PALADINO";
                HUD.set('knight', 'running', 'Revivendo herói');
            } else {
                HUD.set('knight', 'waiting', 'Aguardando cooldown');
            }
        } else {
            HUD.set('knight', 'done', 'Paladino ativo');
        }

        // 4. MARCOS ESTRATÉGICOS (Milestones) - roadmap global + perfil da aldeia
        // Fundações globais vêm primeiro; depois o caminho diverge por perfil
        var _profilePath    = MILESTONES_BY_PROFILE[memory.profile] || MILESTONES_BY_PROFILE.balanced;
        var _allMilestones  = MILESTONES_GLOBAL.concat(_profilePath);
        var activeMilestone = _allMilestones.find(function(m) {
            for (var ed in m.reqs) {
                if (state.niveis[ed] === undefined) continue;
                if (parseInt(state.niveis[ed] || 0) < m.reqs[ed]) return true;
            }
            return false;
        });

        // Persistir milestone atual na memória
        if (activeMilestone) {
            visHUD.meta = '[' + (memory.profile || 'balanced') + '] ' + activeMilestone.label;
            if (memory.currentMilestone !== activeMilestone.id) {
                VillageMemory.set(villageId, 'currentMilestone', activeMilestone.id);
            }
        } else {
            visHUD.meta = '[' + (memory.profile || 'balanced') + '] Otimização';
        }

        // Atualizar status da estátua
        if (state.statueEnabled) {
            if (state.knight.isPresent) {
                HUD.set('statue', 'done', 'Construída');
            } else if (state.knight.isRecruiting) {
                HUD.set('statue', 'running', 'Recrutando paladino');
            } else {
                HUD.set('statue', 'idle', 'Disponível');
            }
        } else {
            HUD.set('statue', 'skip', 'Não disponível');
        }

        // 5. OBRAS GERAIS COM MOTOR DE PRECISÃO
        if (state.filaBuilds < maxFila) {
            var selectedTarget = null;
            var selectedTier = 'P4';
            var selectedScoreMargin = 0;
            var selectedAlternative = null;
            var taxaPop = (state.populacao.current / (state.populacao.max || 1)) * 100;

            // ==========================================
            // SISTEMA PROATIVO DE FARM - 4 NÍVEIS DE ALERTA
            // ==========================================
            // 82% → observação | 88% → preparação | 92% → prioridade alta | 95%+ → emergência
            var nivelAlertaFarm = 'normal';
            if (taxaPop >= 95) nivelAlertaFarm = 'emergencia';
            else if (taxaPop >= 92) nivelAlertaFarm = 'prioridade_alta';
            else if (taxaPop >= 88) nivelAlertaFarm = 'preparacao';
            else if (taxaPop >= 82) nivelAlertaFarm = 'observacao';

            // ==========================================
            // SISTEMA PROATIVO DE STORAGE - PREVISÃO DE OVERFLOW
            // ==========================================
            // Considera: produção atual, loot esperado, rewards, tempo até próxima conclusão
            var riscoArmazem = false;
            var recursosPercent = {
                wood: state.recursos.wood / state.recursos.max,
                stone: state.recursos.stone / state.recursos.max,
                iron: state.recursos.iron / state.recursos.max
            };

            // Calcular produção total por hora de todos os recursos
            var producaoTotalHora = (state.producao.wood || 0) + (state.producao.stone || 0) + (state.producao.iron || 0);

            // Estimar loot esperado baseado em ataques em andamento (se disponível)
            var lootEsperado = state.lootEsperado || 0;

            // Estimar rewards de quests/tasks (se disponível)
            var rewardsEsperados = state.rewardsEsperados || 0;

            // Recursos totais projetados (atual + produção + loot + rewards)
            var recursosTotaisProjetados = state.recursos.wood + state.recursos.stone + state.recursos.iron + lootEsperado + rewardsEsperados;
            var capacidadeTotalArmazem = state.recursos.max * 3; // 3 recursos

            // Percentual projetado considerando influxo futuro
            var percentualProjetado = recursosTotaisProjetados / capacidadeTotalArmazem;

            // Tempo até overflow por recurso individual — decisor primário de risco.
            // Calculado para todos os recursos (não só os acima de 80%).
            var tempoAteOverflow = { wood: 999, stone: 999, iron: 999 };
            ['wood', 'stone', 'iron'].forEach(function(res) {
                var _prod = state.producao[res] || 0;
                var _cap  = state.recursos.max - (state.recursos[res] || 0);
                if (_prod > 0) tempoAteOverflow[res] = _cap / _prod;
            });

            // Ajustar tempo individual por loot e rewards esperados.
            // Distribuição proporcional ao peso atual de cada recurso — individual prevalece sobre agregado.
            if (lootEsperado > 0 || rewardsEsperados > 0) {
                var _totalRes    = (state.recursos.wood || 0) + (state.recursos.stone || 0) + (state.recursos.iron || 0);
                var _influxoTotal = lootEsperado + rewardsEsperados;
                ['wood', 'stone', 'iron'].forEach(function(res) {
                    var _ratio      = _totalRes > 0 ? (state.recursos[res] || 0) / _totalRes : 1 / 3;
                    var _influxoH   = (_influxoTotal * _ratio) / 24;
                    var _capRest    = state.recursos.max - (state.recursos[res] || 0);
                    var _prodTotal  = (state.producao[res] || 0) + _influxoH;
                    if (_prodTotal > 0) {
                        var _t = _capRest / _prodTotal;
                        if (_t < tempoAteOverflow[res]) tempoAteOverflow[res] = _t;
                    }
                });
            }

            // Tempo até gargalo = mínimo individual (não agregado)
            var tempoAteGargalo = Math.min(tempoAteOverflow.wood, tempoAteOverflow.stone, tempoAteOverflow.iron);

            // Decisor individual: recurso >95% OU algum vai encher em < 2h
            riscoArmazem = (recursosPercent.wood  > 0.95 ||
                            recursosPercent.stone > 0.95 ||
                            recursosPercent.iron  > 0.95 ||
                            tempoAteGargalo < 2.0);
            // Contexto agregado como sinal de apoio — reforça mas nunca substitui o individual
            if (!riscoArmazem && percentualProjetado > 0.90) riscoArmazem = true;

            // ==========================================
            // PRIORIDADE 0: NOBLING PREP (main ≥ 20 && smith ≥ 20)
            // Quando os pré-requisitos do milestone noble_prep estão atendidos,
            // entra em modo de acumulação: bloqueia construções não essenciais até
            // juntar NOBLE_COST_EACH × NOBLES_ALVO de cada recurso. Se o armazém
            // for insuficiente para guardar o custo de 1 nobre, constrói storage primeiro.
            // ==========================================
            var noblingPrepBlocking = false;
            var NOBLE_COST_EACH = 60000;
            var NOBLES_ALVO     = 3;
            var noblingTarget   = NOBLE_COST_EACH * NOBLES_ALVO; // 180 000 de cada recurso

            if (parseInt(state.niveis.main  || 0) >= 20
             && parseInt(state.niveis.smith || 0) >= 20) {

                var nStorageOk  = (state.recursos.max || 0) >= NOBLE_COST_EACH;
                var woodFalta   = Math.max(0, noblingTarget - (state.recursos.wood  || 0));
                var stoneFalta  = Math.max(0, noblingTarget - (state.recursos.stone || 0));
                var ironFalta   = Math.max(0, noblingTarget - (state.recursos.iron  || 0));
                var nobleReady  = woodFalta === 0 && stoneFalta === 0 && ironFalta === 0;
                var nobleProgPct = Math.min(100, Math.round(
                    ((Math.min(state.recursos.wood  || 0, noblingTarget)
                    + Math.min(state.recursos.stone || 0, noblingTarget)
                    + Math.min(state.recursos.iron  || 0, noblingTarget))
                    / (noblingTarget * 3)) * 100
                ));

                if (!nStorageOk && isBuildExecutable('storage', state, state._mainDoc)) {
                    // Armazém insuficiente: construir storage como prioridade máxima
                    selectedTarget = 'storage';
                    selectedTier = 'P_NOBLING'; selectedScoreMargin = 999;
                    visHUD.gargalo = "NOBLING: ARMAZÉM";
                    visHUD.motivo  = "Capacidade " + state.recursos.max + " < " + NOBLE_COST_EACH.toLocaleString() + " — ampliar antes de acumular";
                    HUD.set('build_general', 'running', 'Ampliando armazém (Nobling Prep)');
                    log('[nobling-prep] Storage insuficiente (' + state.recursos.max + ' < ' + NOBLE_COST_EACH + '), priorizando construção', 'info');
                } else if (nobleReady) {
                    visHUD.gargalo = "NOBLING READY";
                    visHUD.motivo  = "Recursos para " + NOBLES_ALVO + " nobres acumulados — inicie o recrutamento!";
                    HUD.set('build_general', 'done', 'Pronto para Nobling!');
                    log('[nobling-prep] PRONTO! ' + NOBLES_ALVO + ' nobres financiados. Inicie o recrutamento.', 'success');
                    // Não bloqueia: permite retomar construções normais após acumular
                } else {
                    // Em acumulação ativa: bloquear todas as construções não essenciais
                    noblingPrepBlocking = true;
                    var nobleMsg = nobleProgPct + "% | Falta W:" + Math.floor(woodFalta/1000) + "k S:" + Math.floor(stoneFalta/1000) + "k I:" + Math.floor(ironFalta/1000) + "k";
                    visHUD.gargalo = "NOBLING PREP";
                    visHUD.motivo  = nobleMsg;
                    HUD.set('build_general', 'waiting', 'Acumulando nobres (' + nobleProgPct + '%)');
                    HUD.updateDiagnostics(visHUD.fase, 'NOBLING PREP', NOBLES_ALVO + ' Nobres', 'ACUMULANDO', nobleMsg);
                    log('[nobling-prep] ' + nobleMsg, 'info');
                }
            }

            // ==========================================
            // GARGALO DE POPULAÇÃO — 4 NÍVEIS RÍGIDOS
            // ==========================================
            // P0  Emergência  (95%+):   interrupção total — precede tudo, inclusive nobling
            // P1C Prio. Alta  (92-95%): prioridade explícita — antes de anti-overflow e milestones
            // P3  Preparação  (88-92%): meta latente — farm compete dentro do bloco de milestone
            // P4  Observação  (82-88%): bônus de score apenas (urgênciaGargalo = 1.1)
            var _noblingEssentials = ['farm', 'storage', 'market'];
            // PRIORIDADE 0: Emergência (95%+) — interrupção total
            // Precede nobling prep: pop crítica invalida qualquer outra estratégia
            if (nivelAlertaFarm === 'emergencia' && state.podeSerConstruido['farm'] && isBuildExecutable('farm', state, state._mainDoc)) {
                selectedTarget = 'farm';
                selectedTier = 'P0'; selectedScoreMargin = 999;
                visHUD.gargalo = "POPULAÇÃO (EMERGÊNCIA 95%+)";
                visHUD.motivo = "Pop em " + Math.round(taxaPop) + "% — interrupção total";
            }
            // PRIORIDADE 1: Nobling prep (farm emergência já tratado acima)
            else if (noblingPrepBlocking && _noblingEssentials.indexOf(selectedTarget) === -1) {
                // Nobling Prep: permite farm/storage/market, bloqueia todo o resto
                var _ess = _noblingEssentials.filter(function(b) { return state.podeSerConstruido[b]; });
                if (_ess.length > 0) {
                    selectedTarget = _ess[0];
                    selectedTier = 'P_NOBLING'; selectedScoreMargin = 999;
                    visHUD.gargalo = "NOBLING PREP (essencial)";
                    visHUD.motivo  = "Acumulando nobres — permitindo " + selectedTarget;
                } else {
                    selectedTarget = null;
                }
            } else if (noblingPrepBlocking) {
                // selectedTarget já é essencial — deixa passar
            }
            // PRIORIDADE 1B: Risco iminente de armazém cheio (<1.5h para encher)
            else if (riscoArmazem && tempoAteGargalo < 1.5) {
                // Escolher edifício de recurso mais carente
                // Decisor individual: recurso com menor tempo até overflow — não o de maior % atual
                var recursoMaisCarente = ['wood', 'stone', 'iron'].reduce(function(a, b) {
                    return tempoAteOverflow[a] <= tempoAteOverflow[b] ? a : b;
                });
                if (state.podeSerConstruido[recursoMaisCarente]) {
                    selectedTarget = recursoMaisCarente;
                    selectedTier = 'P1B'; selectedScoreMargin = 999;
                    visHUD.gargalo = "ARMAZÉM CHEIO (CRÍTICO)";
                    visHUD.motivo = Math.round(recursosPercent[recursoMaisCarente]*100) + "% — overflow em " + Math.round(tempoAteOverflow[recursoMaisCarente]*60) + "min";
                }
            }
            // PRIORIDADE 1C: Farm prioridade explícita (92-95%) — antes de overflow e milestones
            else if (nivelAlertaFarm === 'prioridade_alta' && state.podeSerConstruido['farm'] && isBuildExecutable('farm', state, state._mainDoc)) {
                selectedTarget = 'farm';
                selectedTier = 'P1C'; selectedScoreMargin = 999;
                visHUD.gargalo = "POPULAÇÃO (PRIORIDADE EXPLÍCITA 92-95%)";
                visHUD.motivo = "Pop em " + Math.round(taxaPop) + "% — farm obrigatório";
            }
            // PRIORIDADE 2: CONSTRUÇÃO RÁPIDA ANTI-OVERFLOW
            // Quando recursos ≥80% da capacidade, priorizar edifícios com tempo de construção
            // <120s (2 min) no nível atual para consumir recursos e evitar desperdício por overflow.
            else if (recursosPercent.wood > 0.80 || recursosPercent.stone > 0.80 || recursosPercent.iron > 0.80) {
                var recursoMaisCheio = Object.keys(recursosPercent).reduce(function(a, b) {
                    return recursosPercent[a] > recursosPercent[b] ? a : b;
                });

                var _swPhase = state.phase || 'MID';
                var candidatosRapidos = Object.keys(TW_BUILDING_COSTS).filter(function(ed) {
                    if (!state.podeSerConstruido[ed]) return false;
                    if (!isBuildExecutable(ed, state, state._mainDoc)) return false;
                    var custo = TW_BUILDING_COSTS[ed];
                    if (!custo) return false;
                    var phaseWeights = STRATEGIC_WEIGHT[_swPhase] || STRATEGIC_WEIGHT['MID'];
                    var w = phaseWeights[ed];
                    if (w === undefined || w <= 0.5) return false; // exclude low-priority buildings
                    var nivelAtual = parseInt(state.niveis[ed] || 0);
                    var tempoReal = Math.floor(custo[3] * Math.pow(1.1, nivelAtual));
                    return tempoReal < 120;
                });

                if (candidatosRapidos.length > 0) {
                    // Entre os rápidos, priorizar o que consome mais recursos totais no nível atual
                    candidatosRapidos.sort(function(a, b) {
                        var custoA = TW_BUILDING_COSTS[a] || [0, 0, 0, 0];
                        var custoB = TW_BUILDING_COSTS[b] || [0, 0, 0, 0];
                        var nivelA = parseInt(state.niveis[a] || 0);
                        var nivelB = parseInt(state.niveis[b] || 0);
                        var consumoA = (custoA[0] + custoA[1] + custoA[2]) * Math.pow(1.5, nivelA);
                        var consumoB = (custoB[0] + custoB[1] + custoB[2]) * Math.pow(1.5, nivelB);
                        return consumoB - consumoA;
                    });
                    selectedTarget = candidatosRapidos[0];
                    selectedTier = 'P2'; selectedScoreMargin = 999;
                    visHUD.gargalo = "ANTI-OVERFLOW (RÁPIDO)";
                    visHUD.motivo = "Recursos " + recursoMaisCheio + " em " + Math.round(recursosPercent[recursoMaisCheio] * 100) + "% — construção rápida priorizada";
                    log('[motorDeDecisao] Anti-overflow: priorizando ' + selectedTarget + ' (<2min) com ' + recursoMaisCheio + ' em ' + Math.round(recursosPercent[recursoMaisCheio]*100) + '%', 'info');
                }
            }
            // SCORE UNIFICADO — todos os edifícios competem simultaneamente
            // Milestones viram bônus de score (×1.8), não filtros obrigatórios.
            // urgênciaProdução detecta gargalos de mina sem regras manuais.
            else {
                var todosCandidatos = Object.keys(TW_BUILDING_REQS).filter(function(ed) {
                    if (!state.podeSerConstruido[ed]) return false;
                    if (ed === 'snob') return false;
                    if ((state.niveis[ed] || 0) >= 25) return false;
                    if (ed === 'main' && _HQ_LOCKED) return false;
                    return isBuildExecutable(ed, state, state._mainDoc);
                });

                if (todosCandidatos.length > 0) {
                    var nivelHQ = parseInt(state.niveis['main'] || 0);
                    var bonusHQ = HQ_PRODUCTIVITY_BONUS[nivelHQ] || 0;

                    // Produção média/hora — base para detectar mina gargalo
                    var _prodMedia = ((state.producao.wood || 0) + (state.producao.stone || 0) + (state.producao.iron || 0)) / 3;

                    var unified = todosCandidatos.map(function(ed) {
                        var custo = TW_BUILDING_COSTS[ed] || [100, 100, 100, 100];
                        var nivelAtual = parseInt(state.niveis[ed] || 0);
                        var custoNormalizado = ((custo[0] + custo[1] + custo[2]) * Math.pow(1.5, nivelAtual)) / 100;

                        // 1. Peso estratégico (fase + perfil)
                        var pesoBase      = STRATEGIC_WEIGHT[state.phase][ed] || 1.0;
                        var ajustePerfil  = profileWeights[ed] || 1.0;

                        // 2. Retorno contínuo: minas e farm geram recursos indefinidamente
                        var retornoFuturo = ['wood', 'stone', 'iron', 'farm'].includes(ed) ? 1.5 : 1.0;

                        // 3. Urgência de produção: mina produzindo < 60% da média = elo mais fraco
                        var urgênciaProdução = 1.0;
                        if (['wood', 'stone', 'iron'].includes(ed)) {
                            var _prodAtual = state.producao[ed] || 0;
                            if (_prodMedia > 0 && _prodAtual < _prodMedia * 0.60) urgênciaProdução = 1.7;
                            else if (_prodMedia > 0 && _prodAtual < _prodMedia * 0.80) urgênciaProdução = 1.3;
                            if (_prodAtual < 200) urgênciaProdução = Math.max(urgênciaProdução, 1.5); // produção absoluta crítica
                        }

                        // 4. Urgência de gargalo atual (farm + overflow)
                        var urgenciaGargalo = 1.0;
                        if (ed === 'farm') {
                            if (nivelAlertaFarm === 'emergencia')          urgenciaGargalo = 2.0;
                            else if (nivelAlertaFarm === 'prioridade_alta') urgenciaGargalo = 1.5;
                            else if (nivelAlertaFarm === 'preparacao')      urgenciaGargalo = 1.3;
                            else if (nivelAlertaFarm === 'observacao')      urgenciaGargalo = 1.1;
                        }
                        if (riscoArmazem && ['wood', 'stone', 'iron'].includes(ed)) {
                            var _uArm = tempoAteGargalo < 0.5 ? 2.5
                                      : tempoAteGargalo < 1.0 ? 2.0
                                      : tempoAteGargalo < 1.5 ? 1.5 : 1.2;
                            urgenciaGargalo = Math.max(urgenciaGargalo, _uArm);
                        }

                        // 5. Bônus de milestone: edifício no caminho do objetivo atual ganha ×1.8
                        //    Outros ainda competem — mina com produção zero pode vencer
                        var bonusMilestone = 1.0;
                        if (activeMilestone && activeMilestone.reqs[ed]) {
                            var _milNeed = activeMilestone.reqs[ed] - nivelAtual;
                            if (_milNeed > 0) bonusMilestone = 1.8;
                        }

                        // 6. HQ throughput multiplier
                        var bonusHQProd = 1.0 + bonusHQ;
                        if (ed === 'main') {
                            var _bonusNext = HQ_PRODUCTIVITY_BONUS[nivelAtual + 1] || bonusHQ;
                            var _ganho     = _bonusNext - bonusHQ;
                            var _obras     = Math.max(6, 22 - nivelAtual);
                            bonusHQProd = 1.0 + Math.max(bonusHQ * 3.0, _ganho * _obras);
                        }

                        // 7. Bônus de pré-requisito: desbloqueia edifício importante
                        var bonusPreReq = 0;
                        for (var _otherEd in TW_BUILDING_REQS) {
                            if (TW_BUILDING_REQS[_otherEd][ed] && !state.podeSerConstruido[_otherEd]) bonusPreReq += 0.2;
                        }

                        // SCORE UNIFICADO
                        var score = (pesoBase * ajustePerfil * retornoFuturo * urgênciaProdução * urgenciaGargalo * bonusMilestone * bonusHQProd)
                                  / (custoNormalizado * (nivelAtual + 1) * 0.1);
                        score += bonusPreReq;

                        // HQ milestone multipliers (zerado se travado)
                        if (ed === 'main') {
                            if (_HQ_LOCKED)           score *= 0.0;
                            else if (nivelAtual < 5)  score *= 2.0;
                            else if (nivelAtual < 10) score *= 1.6;
                            else if (nivelAtual < 15) score *= 1.3;
                            else if (nivelAtual < 20) score *= 1.15;
                        }
                        // Fila + recursos sobrando: HQ converte ociosidade em throughput permanente
                        var _recursosSobrando = recursosPercent.wood > 0.70 && recursosPercent.stone > 0.70 && recursosPercent.iron > 0.70;
                        if (ed === 'main' && state.filaBuilds >= 1 && _recursosSobrando) score *= 1.5;

                        // RUSH DE CL (Manual 2026)
                        var _stableLvl = parseInt(state.niveis['stable'] || 0);
                        if (state.phase === 'EARLY' && _stableLvl >= 3) {
                            if (ed === 'smith' || ed === 'stable') score *= 3.5;
                            if (ed === 'iron')                     score *= 2.2;
                            if (ed === 'main' && nivelAtual >= 10) score *= 0.4;
                            else if (ed === 'main' && nivelAtual >= 5) score *= 0.65;
                        }

                        // Smith pronto (≥5) mas Estábulo ainda ausente: boost urgente
                        var _smithPronto = parseInt(state.niveis['smith'] || 0) >= 5;
                        if (state.phase === 'EARLY' && _smithPronto && _stLvl < 1 && ed === 'stable') score *= 4.0;

                        return { ed: ed, score: score };
                    });

                    unified.sort(function(a, b) { return b.score - a.score; });
                    selectedTarget = unified[0].ed;

                    // Tier: P3 se vencedor alinhado com milestone, P4 se venceu por score puro
                    var _onMilestone = !!(activeMilestone && activeMilestone.reqs[selectedTarget] &&
                                         (activeMilestone.reqs[selectedTarget] - parseInt(state.niveis[selectedTarget] || 0)) > 0);
                    selectedTier = _onMilestone ? 'P3' : 'P4';
                    selectedScoreMargin = unified.length > 1 ? unified[0].score - unified[1].score : unified[0].score;
                    selectedAlternative = unified.length > 1 ? unified[1] : null;

                    visHUD.gargalo = _onMilestone ? "SCORE UNIFICADO + MILESTONE" : "SCORE UNIFICADO";
                    visHUD.motivo  = _onMilestone
                        ? selectedTarget + " vence score global | Marco: " + activeMilestone.label
                        : "Melhor ROI global: " + selectedTarget + " (" + unified[0].score.toFixed(1) + ")";
                }
            }
            if (selectedTarget) {
                // Verificar se target foi bloqueado por falhas anteriores
                if (VillageMemory.isTargetBlocked(villageId, selectedTarget)) {
                    log('[motorDeDecisao] Target ' + selectedTarget + ' está bloqueado, buscando alternativa', 'warning');
                    visHUD.gargalo = 'BLOQUEADO';
                    visHUD.motivo = 'Target anterior falhou, evitando repetição';
                    // Não adicionar este target às tarefas
                } else {
                    tasks.push({ id: 'build_general', action: 'DO', target: selectedTarget, tier: selectedTier, scoreMargin: selectedScoreMargin, alternative: selectedAlternative });
                    visHUD.acao = selectedTarget.toUpperCase();
                    HUD.set('build_general', 'running', 'Construindo ' + selectedTarget);

                    // Persistir gargalo anterior para comparação futura
                    if (memory.previousBottleneck !== visHUD.gargalo) {
                        VillageMemory.set(villageId, 'previousBottleneck', visHUD.gargalo);
                    }
                }
            } else {
                HUD.set('build_general', 'idle', 'Aguardando vaga na fila');
            }
        } else {
            HUD.set('build_general', 'waiting', 'Fila cheia (' + state.filaBuilds + '/' + maxFila + ')');
        }

        // Atualizar memória com última ação planejada
        if (tasks.length > 0 && !memory.actionLock) {
            var lastTask = tasks[tasks.length - 1];
            if (lastTask.target) {
                VillageMemory.set(villageId, 'lastTarget', lastTask.target);
            }
        }

        // RECOMPENSAS DE QUESTS
        // Dispara quando a fila tem vaga mas não há target de construção (recursos insuficientes).
        // A nova bgClaimQuestRewards faz POST direto — não precisa de popup nem pré-carregamento.
        var _questCooldownKey = 'twbot_quest_claim_ts_' + state.villageId;
        var _questCooldownOk  = (Date.now() - GM_getValue(_questCooldownKey, 0)) > 60000;
        var _resourcesInsuf   = !selectedTarget && state.filaBuilds < maxFila && !noblingPrepBlocking;

        if (_questCooldownOk && _resourcesInsuf) {
            tasks.unshift({ id: 'claim_quest_rewards', action: 'DO' });
            GM_setValue(_questCooldownKey, Date.now());
            log('[motorDeDecisao] Recursos insuficientes — agendando coleta de recompensas de quests', 'info');
            HUD.set('build_general', 'waiting', 'Buscando recompensas de quests...');
        }

        HUD.updateDiagnostics(visHUD.fase, visHUD.gargalo, visHUD.meta, visHUD.acao, visHUD.motivo);
        return Promise.resolve(tasks);
    }

    // ============================================================
    // FUNÇÃO DE CLIQUE NO DOM PARA CONSTRUÇÃO (Alternativa ao AJAX)
    // Estratégia multi-camada: linha específica → seletores globais → fallback visual
    // ============================================================
    async function clicarBotaoConstruir(buildingName) {
        console.log(`[TWBot] 🔨 Tentando construir: ${buildingName}`);

        // 1. Estratégia Direta: Procurar pela LINHA da tabela específica do edifício
        const rowSelectors = [
            `tr[id*="${buildingName}_buildrow"]`,
            `tr#${buildingName}_buildrow_${buildingName}`,
            `tr[id^="${buildingName}_buildrow"]`
        ];

        let row = null;
        for (const rSel of rowSelectors) {
            row = document.querySelector(rSel);
            if (row) break;
        }

        let btn = null;
        let usedStrategy = "";

        // Se achou a linha, procura o botão DENTRO dela
        if (row) {
            console.log(`[TWBot] 📍 Linha da tabela encontrada para ${buildingName}. Buscando botão interno...`);
            const internalCandidates = row.querySelectorAll('a[id*="buildlink"], a.btn, input[type="submit"], button');

            for (const el of internalCandidates) {
                const isDisabled = el.classList.contains('disabled') ||
                                   el.hasAttribute('disabled') ||
                                   el.style.opacity === '0.5' ||
                                   el.parentElement?.classList.contains('disabled');

                const text = (el.innerText || el.value || "").toLowerCase();
                const isAction = text.includes('bauen') || text.includes('ausbauen') || text.includes('stufe') || el.id.includes('buildlink');

                if (!isDisabled && (isAction || el.id.includes('buildlink'))) {
                    btn = el;
                    usedStrategy = `row-specific (${row.id})`;
                    break;
                }
            }
        }

        // 2. Fallback Global
        if (!btn) {
            console.log(`[TWBot] 🔍 Linha não encontrada. Tentando seletores globais...`);
            const possibleSelectors = [
                `a[id*="${buildingName}_buildlink"]:not(.disabled)`,
                `a.btn-build[data-building="${buildingName}"]:not(.disabled)`,
                `form[id*="${buildingName}"] input[type="submit"]:not(.disabled)`,
                `td#content_value a[id*="buildlink"]:not(.disabled)`
            ];

            for (const selector of possibleSelectors) {
                btn = document.querySelector(selector);
                if (btn) {
                    usedStrategy = `global-selector (${selector})`;
                    break;
                }
            }
        }

        // 3. Fallback Visual
        if (!btn) {
            const contentArea = document.querySelector('td#content_value');
            if (contentArea) {
                const candidates = contentArea.querySelectorAll('a, input, button');
                for (const el of candidates) {
                    const text = (el.innerText || el.value || "").toLowerCase();
                    const isBuildAction = (text.includes('ausbauen') || text.includes('bauen') || text.match(/stufe\s*\d+/)) && el.offsetParent !== null;

                    if (isBuildAction && !el.classList.contains('disabled')) {
                        btn = el;
                        usedStrategy = "visual-fallback";
                        break;
                    }
                }
            }
        }

        // AÇÃO FINAL
        if (btn) {
            console.log(`[TWBot] ✅ SUCESSO! Botão encontrado via: ${usedStrategy}`);
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 600));

            btn.focus();
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 100));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            btn.click();

            console.log(`[TWBot] 🖱️ Clique enviado para ${buildingName}`);
            return true;
        } else {
            console.warn(`[TWBot] ❌ FALHA REAL: Nenhum botão encontrado para ${buildingName}.`);
            console.warn(`[TWBot] 💡 Motivo provável: Fila cheia, recursos insuficientes ou edifício no nível máximo.`);
            return false;
        }
    }

    // ============================================================================
    // FUNÇÃO DE CONSTRUÇÃO ASSÍNCRONA - NOVA ABORDAGEM (FUNCIONA EM SEGUNDO PLANO)
    // ============================================================================
    async function tentarConstruirEdificio(nomeEdificio) {
        console.log(`[TWBot] 🏗️ Iniciando processo de construção para: ${nomeEdificio}`);

        // Obter estado atual do DOM (necessário para verificar botão e recursos em tempo real)
        // CORREÇÃO: Obter village_id do DOM/URL ao invés de Game.village_id (que pode não estar definido)
        var villageId = null;
        try {
            // Tentar obter do objeto Game se existir
            if (typeof Game !== 'undefined' && Game.village_id) {
                villageId = normalizeVillageId(Game.village_id);
            } else {
                // Fallback: extrair da URL ou do DOM
                var urlMatch = window.location.href.match(/[?&]village=(\d+)/);
                if (urlMatch) {
                    villageId = urlMatch[1]; // regex já captura apenas dígitos
                } else {
                    var villageEl = document.querySelector('#village_switch_left, #village_switch_right, .village_info .name');
                    if (villageEl && villageEl.href) {
                        var hrefMatch = villageEl.href.match(/[?&]village=(\d+)/);
                        if (hrefMatch) {
                            villageId = hrefMatch[1];
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[TWBot] Erro ao obter village_id, tentando continuar...');
        }

        // Se não conseguiu obter village_id, tenta usar o estado coletado
        if (!villageId) {
            console.warn('[TWBot] Não foi possível obter village_id, verificando se temos estado...');
            // Em segundo plano, podemos não ter acesso ao DOM, então vamos direto para a requisição
        }

        var mainDoc = document; // Usar o documento atual

        // 1. Verificar se botão está disponível no DOM (validação rápida)
        // SE estiver em segundo plano e o DOM não estiver acessível, pula esta verificação
        var buttonAvailable = false;
        try {
            buttonAvailable = isButtonAvailable(nomeEdificio, mainDoc);
        } catch (e) {
            console.log(`[TWBot] ⚠️ DOM não acessível (segundo plano), pulando verificação visual...`);
            buttonAvailable = true; // Assume que está disponível e tenta a requisição
        }

        if (!buttonAvailable) {
            console.log(`[TWBot] ⚠️ ${nomeEdificio} botão não disponível (fila cheia, nível máximo ou sem recursos)`);
            return false;
        }

        // 2. Extrair recursos atuais do DOM (código inline baseado em collectVillageState)
        // SE estiver em segundo plano, usa os dados do estado coletado anteriormente
        var woodFromDOM = 0, stoneFromDOM = 0, ironFromDOM = 0;
        var recursosDisponiveis = false;

        try {
            var woodEl = mainDoc.querySelector('#resource_span .wood, .res .wood, #resources .wood');
            var stoneEl = mainDoc.querySelector('#resource_span .stone, .res .stone, #resources .stone');
            var ironEl = mainDoc.querySelector('#resource_span .iron, .res .iron, #resources .iron');

            if (woodEl) {
                var woodText = woodEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                woodFromDOM = parseInt(woodText) || 0;
                recursosDisponiveis = true;
            }
            if (stoneEl) {
                var stoneText = stoneEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                stoneFromDOM = parseInt(stoneText) || 0;
            }
            if (ironEl) {
                var ironText = ironEl.textContent.trim().replace(/[,.]/g, '').replace(/[^0-9]/g, '');
                ironFromDOM = parseInt(ironText) || 0;
            }
        } catch (e) {
            console.log(`[TWBot] ⚠️ Não foi possível ler recursos do DOM (segundo plano)`);
            recursosDisponiveis = false;
        }

        var recursosDOM = { wood: woodFromDOM, stone: stoneFromDOM, iron: ironFromDOM };

        // Obter nível atual do edifício (se DOM disponível)
        var nivelAtual = 0;
        try {
            var buildingRow = mainDoc.querySelector('#building_' + nomeEdificio);
            if (buildingRow) {
                var levelMatch = buildingRow.className.match(/level_(\d+)/);
                if (levelMatch) {
                    nivelAtual = parseInt(levelMatch[1]);
                }
            }
        } catch (e) {
            console.log(`[TWBot] ⚠️ Não foi possível obter nível do edifício (segundo plano)`);
        }

        // Verificar recursos apenas se conseguimos ler do DOM
        if (recursosDisponiveis && recursosDOM.wood > 0) {
            var custosBase = TW_BUILDING_COSTS[nomeEdificio];

            if (custosBase) {
                var custoMadeira = Math.floor(custosBase[0] * Math.pow(1.5, nivelAtual));
                var custoPedra = Math.floor(custosBase[1] * Math.pow(1.5, nivelAtual));
                var custoFerro = Math.floor(custosBase[2] * Math.pow(1.5, nivelAtual));

                if (recursosDOM.wood < custoMadeira || recursosDOM.stone < custoPedra || recursosDOM.iron < custoFerro) {
                    console.log(`[TWBot] ⚠️ ${nomeEdificio} sem recursos suficientes. Necessário: W=${custoMadeira}, S=${custoPedra}, I=${custoFerro}`);
                    return false;
                }
            }
        }

        // 3. A MÁGICA ACONTECE AQUI:
        // Tenta primeiro clicar no botão (se DOM disponível), senão faz requisição direta
        var sucesso = false;

        // Tenta encontrar e clicar o botão (funciona apenas se a página estiver carregada)
        try {
            sucesso = await clicarBotaoConstruir(nomeEdificio);
        } catch (e) {
            console.log(`[TWBot] ⚠️ Não foi possível clicar no botão via DOM, usando fallback AJAX...`);
            sucesso = false;
        }

        // Se não conseguiu clicar (segundo plano), faz requisição AJAX direta
        if (!sucesso && villageId) {
            console.log(`[TWBot] 🔄 Usando método de requisição direta para ${nomeEdificio}...`);

            // Obter CSRF do estado global ou do game_data
            var csrf = null;
            try {
                if (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data && unsafeWindow.game_data.csrf) {
                    csrf = unsafeWindow.game_data.csrf;
                } else if (typeof game_data !== 'undefined' && game_data && game_data.csrf) {
                    csrf = game_data.csrf;
                }
            } catch (e) {}

            if (!csrf) {
                console.error(`[TWBot] ❌ CSRF não disponível, não é possível construir ${nomeEdificio}`);
                return false;
            }

            // Fazer requisição direta usando bgBuildGeneric
            sucesso = await bgBuildGeneric(villageId, nomeEdificio, csrf);
        }

        if (sucesso) {
            console.log(`[TWBot] ✅ Construção de ${nomeEdificio} iniciada com sucesso!`);
            return true;
        } else {
            console.log(`[TWBot] ⏸️ Não foi possível construir ${nomeEdificio} agora. Verificando fila/recursos.`);
            return false;
        }
    }

    // Função bgBuildGeneric atualizada para ser assíncrona (usada como fallback em segundo plano)
    async function bgBuildGeneric(villageId, building, csrf) {
        var origin = window.location.origin;
        // URL correta para upgrade de edifícios no Tribal Wars (type=main é obrigatório)
        var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
        var body = 'id=' + building + '&force=1&destroy=0&source=' + villageId + '&h=' + csrf;

        log('[builder] Solicitando upgrade de ' + building + '...', 'info');

        try {
            var resp = await twFetch(buildUrl, 'POST', body);
            // Usar camada de verificação robusta
            var success = verifyQueuedAfterBuild(resp, building);
            if (success) {
                log('[builder] ' + building + ' confirmado na fila!', 'success');
                // Pequeno delay para o servidor processar antes da próxima ação
                await new Promise(resolve => setTimeout(resolve, 500));
                return true;
            } else {
                log('[builder] Falha ao confirmar ' + building + ' na fila', 'error');
                // Log da resposta completa para debug
                log('[builder] Resposta recebida: ' + resp.substring(0, 200), 'warning');
                return false;
            }
        } catch(err) {
            log('[builder] Erro na requisição de ' + building + ': ' + err, 'error');
            return false;
        }
    }

    // ============================================================
    // CONSTRUIR EM SEGUNDO PLANO (AJAX FANTASMA)
    // Não procura botão no DOM. Envia POST direto ao servidor.
    // ============================================================
    function bgUpgradeBuilding(villageId, buildingName) {
        var origin = window.location.origin;
        var mainUrl = origin + '/game.php?village=' + villageId + '&screen=main';

        log('[ghost-build] Verificando ' + buildingName + '...');

        return twFetch(mainUrl, 'GET', null, false).then(function(html) {
            // CSRF: unsafeWindow > game_data > extração do HTML
            var csrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data && unsafeWindow.game_data.csrf)
                ? unsafeWindow.game_data.csrf
                : ((typeof game_data !== 'undefined' && game_data && game_data.csrf)
                    ? game_data.csrf
                    : extractCsrf(html));

            if (!csrf) {
                log('[ghost-build] CSRF não encontrado!', 'error');
                HUD.set('build_general', 'error', 'Sem CSRF');
                return { ok: false, reason: 'no_csrf' };
            }

            // Sinalização textual de recursos insuficientes no HTML
            var noResText = html.indexOf('Pas assez de ressources') !== -1 ||
                            html.indexOf('not enough resources')    !== -1 ||
                            html.indexOf('recursos insuficientes')  !== -1;
            if (noResText) {
                log('[ghost-build] Recursos insuficientes para ' + buildingName + ' (texto servidor) — aguardando', 'info');
                HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + buildingName);
                return { ok: false, reason: 'no_resources' };
            }

            // Validação DOM: extrair custos reais e comparar com recursos atuais
            var mainDoc = new DOMParser().parseFromString(html, 'text/html');
            var baseCosts = TW_BUILDING_COSTS[buildingName];
            var costs = extractCosts(buildingName, mainDoc, baseCosts);
            if (costs) {
                log('[ghost-build] Custos: W=' + costs.wood + ' S=' + costs.stone + ' I=' + costs.iron + (costs.fromDOM ? ' (DOM)' : ' (tabela)'), 'debug');
                var curWood = 0, curStone = 0, curIron = 0;
                try {
                    var win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                    curWood  = parseInt(win.game_data.village.wood  || 0) || 0;
                    curStone = parseInt(win.game_data.village.stone || 0) || 0;
                    curIron  = parseInt(win.game_data.village.iron  || 0) || 0;
                } catch(e) {
                    var spW = mainDoc.querySelector('#wood, #wood_current, .wood_current');
                    var spS = mainDoc.querySelector('#stone, #stone_current, .stone_current');
                    var spI = mainDoc.querySelector('#iron, #iron_current, .iron_current');
                    curWood  = spW ? parseInt((spW.textContent || '').replace(/\D/g, '')) || 0 : 0;
                    curStone = spS ? parseInt((spS.textContent || '').replace(/\D/g, '')) || 0 : 0;
                    curIron  = spI ? parseInt((spI.textContent || '').replace(/\D/g, '')) || 0 : 0;
                }
                if ((curWood > 0 || curStone > 0 || curIron > 0) &&
                    (costs.wood > curWood || costs.stone > curStone || costs.iron > curIron)) {
                    log('[ghost-build] Recursos insuficientes para ' + buildingName + ' (validação interna) — aguardando', 'info');
                    HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + buildingName);
                    // Delta detectado entre custo estimado e custo real: forçar recalibração
                    (function() {
                        var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                        _bs.attempts    = (_bs.attempts    || 0) + 1;
                        _bs.no_resources = (_bs.no_resources || 0) + 1;
                        if (_bs.no_resources >= 3 && _bs.no_resources / _bs.attempts > 0.3) {
                            GM_setValue('twbot_force_rescrape', 1);
                            _bs.no_resources = 0; _bs.attempts = 0; // reset após trigger
                            log('[costs-scraper] Taxa de confirmação baixa — revalidação de custos agendada', 'warning');
                        }
                        GM_setValue('twbot_build_stats', JSON.stringify(_bs));
                    })();
                    return { ok: false, reason: 'no_resources' };
                }
            }

            var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
            var body = 'id=' + buildingName + '&force=1&destroy=0&source=' + villageId + '&h=' + csrf;

            HUD.set('build_general', 'running', 'Construindo ' + buildingName);

            return twFetch(buildUrl, 'POST', body).then(function(resp) {
                var success = false;
                var errorMsg = '';
                try {
                    var json = JSON.parse(resp);
                    success = !!(json.success || json.order_id);
                    if (!success && json.error) errorMsg = json.error;
                } catch (e) {
                    success = resp.indexOf('success') !== -1 || resp.indexOf('order') !== -1;
                }

                if (success) {
                    log('[ghost-build] ' + buildingName + ' enfileirado com sucesso', 'success');
                    HUD.set('build_general', 'done', buildingName + ' enfileirado!');
                    (function() {
                        var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                        _bs.attempts  = (_bs.attempts  || 0) + 1;
                        _bs.confirmed = (_bs.confirmed || 0) + 1;
                        GM_setValue('twbot_build_stats', JSON.stringify(_bs));
                    })();
                    return { ok: true };
                } else {
                    log('[ghost-build] Falha ao construir ' + buildingName + (errorMsg ? ': ' + errorMsg : ''), 'error');
                    HUD.set('build_general', 'error', 'Falha: ' + (errorMsg || 'sem detalhes'));
                    return { ok: false, reason: 'build_fail' };
                }
            });
        }).catch(function(e) {
            log('[ghost-build] Erro de rede: ' + e.message, 'error');
            return { ok: false, reason: 'network_error' };
        });
    }

    // ============================================================
    // EXECUTOR CANÔNICO DE BUILD — pipeline unificado
    // Substitui: bgUpgradeBuilding + bgBuildGeneric + clicarBotaoConstruir
    // plan: { villageId, building }
    // Retorna Promise<{ ok: boolean, reason: string }>
    // Estratégia: GET main (CSRF+custo) → AJAX POST → fallback DOM click
    // ============================================================
    async function executeBuildPlan(plan) {
        var villageId = plan.villageId;
        var building  = plan.building;
        var origin    = window.location.origin;
        var mainUrl   = origin + '/game.php?village=' + villageId + '&screen=main';

        log('[build] executeBuildPlan → ' + building, 'info');

        // ── Etapa 1: GET main — CSRF fresco + validação de custos ──
        var html;
        try {
            html = await twFetch(mainUrl, 'GET', null, false);
        } catch (e) {
            log('[build] Erro de rede (GET main): ' + e.message, 'error');
            return { ok: false, reason: 'network_error' };
        }

        // CSRF: unsafeWindow > game_data > extração do HTML
        var csrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data && unsafeWindow.game_data.csrf)
            ? unsafeWindow.game_data.csrf
            : ((typeof game_data !== 'undefined' && game_data && game_data.csrf)
                ? game_data.csrf
                : extractCsrf(html));

        if (!csrf) {
            log('[build] CSRF não encontrado!', 'error');
            HUD.set('build_general', 'error', 'Sem CSRF');
            return { ok: false, reason: 'no_csrf' };
        }

        // Sinalização textual de recursos insuficientes no HTML
        if (html.indexOf('Pas assez de ressources') !== -1 ||
            html.indexOf('not enough resources')    !== -1 ||
            html.indexOf('recursos insuficientes')  !== -1) {
            log('[build] Recursos insuficientes para ' + building + ' (texto servidor)', 'info');
            HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + building);
            return { ok: false, reason: 'no_resources' };
        }

        // Validação DOM: custos reais vs recursos atuais
        var mainDoc = new DOMParser().parseFromString(html, 'text/html');
        var baseCosts = TW_BUILDING_COSTS[building];
        var costs = extractCosts(building, mainDoc, baseCosts);
        if (costs) {
            log('[build] Custos: W=' + costs.wood + ' S=' + costs.stone + ' I=' + costs.iron + (costs.fromDOM ? ' (DOM)' : ' (tabela)'), 'debug');
            var curWood = 0, curStone = 0, curIron = 0;
            try {
                var _win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                curWood  = parseInt(_win.game_data.village.wood  || 0) || 0;
                curStone = parseInt(_win.game_data.village.stone || 0) || 0;
                curIron  = parseInt(_win.game_data.village.iron  || 0) || 0;
            } catch(e) {
                var _spW = mainDoc.querySelector('#wood, #wood_current, .wood_current');
                var _spS = mainDoc.querySelector('#stone, #stone_current, .stone_current');
                var _spI = mainDoc.querySelector('#iron, #iron_current, .iron_current');
                curWood  = _spW ? parseInt((_spW.textContent || '').replace(/\D/g, '')) || 0 : 0;
                curStone = _spS ? parseInt((_spS.textContent || '').replace(/\D/g, '')) || 0 : 0;
                curIron  = _spI ? parseInt((_spI.textContent || '').replace(/\D/g, '')) || 0 : 0;
            }
            if ((curWood > 0 || curStone > 0 || curIron > 0) &&
                (costs.wood > curWood || costs.stone > curStone || costs.iron > curIron)) {
                log('[build] Recursos insuficientes para ' + building + ' (validação interna)', 'info');
                HUD.set('build_general', 'waiting', 'Aguardando recursos para ' + building);
                // Revalidação de custos se taxa de falha por recursos for alta
                (function() {
                    var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                    _bs.attempts     = (_bs.attempts     || 0) + 1;
                    _bs.no_resources = (_bs.no_resources || 0) + 1;
                    if (_bs.no_resources >= 3 && _bs.no_resources / _bs.attempts > 0.3) {
                        GM_setValue('twbot_force_rescrape', 1);
                        _bs.no_resources = 0; _bs.attempts = 0;
                        log('[build] Taxa de confirmação baixa — revalidação de custos agendada', 'warning');
                    }
                    GM_setValue('twbot_build_stats', JSON.stringify(_bs));
                })();
                return { ok: false, reason: 'no_resources' };
            }
        }

        // ── Etapa 2: AJAX ghost-build (caminho primário) ──
        var buildUrl = origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=upgrade_building&type=main';
        var body     = 'id=' + building + '&force=1&destroy=0&source=' + villageId + '&h=' + csrf;

        HUD.set('build_general', 'running', 'Construindo ' + building);

        var ajaxOk = false;
        var errorMsg = '';
        try {
            var resp = await twFetch(buildUrl, 'POST', body);
            try {
                var json = JSON.parse(resp);
                ajaxOk = !!(json.success || json.order_id);
                if (!ajaxOk && json.error) errorMsg = json.error;
            } catch (e) {
                ajaxOk = resp.indexOf('success') !== -1 || resp.indexOf('order') !== -1;
            }
        } catch (e) {
            log('[build] Erro de rede (AJAX POST): ' + e.message, 'error');
        }

        if (ajaxOk) {
            log('[build] ' + building + ' enfileirado via AJAX', 'success');
            HUD.set('build_general', 'done', building + ' enfileirado!');
            (function() {
                var _bs = {}; try { _bs = JSON.parse(GM_getValue('twbot_build_stats', '{}') || '{}'); } catch(e) {}
                _bs.attempts  = (_bs.attempts  || 0) + 1;
                _bs.confirmed = (_bs.confirmed || 0) + 1;
                GM_setValue('twbot_build_stats', JSON.stringify(_bs));
            })();
            VillageMemory.recordSuccess(villageId, building);
            return { ok: true, reason: 'ajax' };
        }

        // ── Etapa 3: Fallback — clique DOM ──
        log('[build] AJAX falhou (' + (errorMsg || 'sem detalhes') + ') — fallback DOM click...', 'warning');
        var domOk = false;
        try {
            domOk = await clicarBotaoConstruir(building);
        } catch (e) {
            log('[build] Erro no clique DOM: ' + e.message, 'error');
        }

        if (domOk) {
            log('[build] ' + building + ' enfileirado via clique DOM', 'success');
            HUD.set('build_general', 'done', building + ' enfileirado (DOM)!');
            VillageMemory.recordSuccess(villageId, building);
            return { ok: true, reason: 'dom_click' };
        }

        // ── Falha total ──
        log('[build] Falha total para ' + building + (errorMsg ? ': ' + errorMsg : ''), 'error');
        HUD.set('build_general', 'error', 'Falha: ' + (errorMsg || 'sem detalhes'));
        VillageMemory.recordError(villageId, building, 'build_fail');
        return { ok: false, reason: 'build_fail' };
    }

   // ============================================================
    // MAIN CHECKLIST ORCHESTRATOR - O CORAÇÃO DO BOT (V5.2)
    // ============================================================
   function bgBuildRush(villageId, orderId, csrf) {
        // Busca o CSRF mais atualizado diretamente do objeto do jogo para não usar token velho
        var activeCsrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data)
            ? unsafeWindow.game_data.csrf
            : (typeof game_data !== 'undefined' && game_data ? game_data.csrf : csrf);

        var url = window.location.origin + '/game.php?village=' + villageId + '&screen=main&ajaxaction=build_order_reduce&h=' + activeCsrf + '&id=' + orderId + '&destroy=0';

        return twFetch(url, 'GET').then(resp => {

            try {
                var json = JSON.parse(resp);
                if (json.success) {
                    log('[rush] SUCESSO! Construção ' + orderId + ' finalizada instantaneamente!', 'success');
                    HUD.set('build_general', 'done', 'Rush completado!');
                    return true;
                } else if (json.error) {
                    log('[rush] ERRO do servidor: ' + json.error, 'error');
                    HUD.set('build_general', 'error', 'Rush falhou: ' + json.error);
                    return false;
                } else {
                    log('[rush] Resposta JSON sem success/error: ' + JSON.stringify(json), 'warning');
                    return false;
                }
            } catch (e) {
                // Se não for JSON, verifica se a página retornou sucesso por texto
                if (resp.indexOf('success') !== -1 || resp.indexOf('Construção finalizada') !== -1) {
                    log('[rush] SUCESSO (texto)! Construção finalizada.', 'success');
                    return true;
                } else {
                    log('[rush] Falha ao finalizar rush. Resposta não-JSON: ' + resp.substring(0, 100), 'error');
                    HUD.set('build_general', 'error', 'Rush falhou (resposta inválida)');
                    return false;
                }
            }
        }).catch(function(err) {
            log('[rush] ERRO DE REDE/EXCEPTION: ' + err.message, 'error');
            HUD.set('build_general', 'error', 'Erro de rede no rush');
            return false;
        });
    }
    function bgRushKnight(villageId, knightId, csrf) {
        var origin = window.location.origin;
        var activeCsrf = (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data)
            ? unsafeWindow.game_data.csrf
            : (typeof game_data !== 'undefined' && game_data ? game_data.csrf : csrf);

        log('[knight-rush] Disparando rush no paladino ID: ' + knightId, 'info');
        HUD.set('knight', 'running', 'Finalizando paladino...');

        var rushUrl  = origin + '/game.php?village=' + villageId + '&screen=statue&ajaxaction=recruit_rush';
        var rushBody = 'knight=' + knightId + '&home=' + villageId + '&h=' + activeCsrf;

        return twFetch(rushUrl, 'POST', rushBody).then(function(resp) {
            try {
                var json = JSON.parse(resp);
                if (json.success) {
                    log('[knight-rush] Paladino finalizado instantaneamente!', 'success');
                    GM_setValue('knight_done_' + villageId, Date.now());
                    HUD.set('knight', 'done', 'Recrutado!');
                    return true;
                }
                log('[knight-rush] Servidor recusou rush: ' + JSON.stringify(json).slice(0, 100), 'warning');
                return false;
            } catch (e) {
                if (resp.indexOf('success') !== -1) {
                    log('[knight-rush] Rush concluído (texto).', 'success');
                    return true;
                }
                log('[knight-rush] Resposta inválida: ' + resp.slice(0, 80), 'error');
                return false;
            }
        }).catch(function(err) {
            log('[knight-rush] Erro de rede: ' + err.message, 'error');
            return false;
        });
    }

    // ============================================================
    // RECOMPENSAS DE QUESTS — coleta automática com proteção contra overflow
    // ============================================================

    /**
     * Parseia o HTML do popup de quests (screen=new_quests&ajax=quest_popup)
     * e retorna lista de recompensas disponíveis com seus IDs e quantidades de recursos.
     * Suporta resposta JSON ou HTML (estrutura TW 10.x).
     */
    function parseQuestRewards(html) {
        if (!html) return [];
        var rewards = [];

        // Tentativa 1: JSON direto
        try {
            var json = JSON.parse(html);
            var list = json.rewards || json.quest_rewards || json.data || json.items || [];
            if (Array.isArray(list)) {
                var mapped = list.map(function(r) {
                    return {
                        id:    String(r.reward_id || r.id || r.quest_id || ''),
                        wood:  parseInt(r.wood  || (r.resources && r.resources.wood)  || 0) || 0,
                        stone: parseInt(r.stone || (r.resources && r.resources.stone) || 0) || 0,
                        iron:  parseInt(r.iron  || (r.resources && r.resources.iron)  || 0) || 0
                    };
                }).filter(function(r) { return r.id; });
                if (mapped.length) return mapped;
            }
        } catch(e) {}

        // Tentativa 2: HTML parsing ampliado (nova estrutura TW)
        var doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('.quest-reward, .reward-item, [data-reward-id], form[action*="claim"], .reward-row, tr.reward').forEach(function(el) {
            var idInput = el.querySelector('input[name="reward_id"], input[name="id"]');
            var formInput = el.closest && el.closest('form') && el.closest('form').querySelector('input[name="reward_id"]');
            var id = el.getAttribute('data-reward-id')
                  || (idInput && idInput.value)
                  || (formInput && formInput.value);
            if (!id) {
                var a = el.href ? el : (el.querySelector && el.querySelector('a'));
                var m = a && (a.href || '').match(/reward_id=(\d+)/i);
                if (m) id = m[1];
            }
            if (!id || isNaN(id)) return;
            var res = { wood: 0, stone: 0, iron: 0 };
            ['wood', 'stone', 'iron'].forEach(function(type) {
                el.querySelectorAll('.' + type + ', [class*="' + type + '"], .res_' + type).forEach(function(e) {
                    var n = parseInt((e.textContent || '').replace(/[^0-9]/g, '')) || 0;
                    if (n > res[type]) res[type] = n;
                });
            });
            rewards.push({ id: String(id), wood: res.wood, stone: res.stone, iron: res.iron });
        });

        // Tentativa 3: fallback — qualquer link com reward_id
        if (rewards.length === 0) {
            doc.querySelectorAll('a[href*="reward_id="]').forEach(function(el) {
                var m = (el.href || '').match(/reward_id=(\d+)/i);
                if (m) rewards.push({ id: m[1], wood: 0, stone: 0, iron: 0 });
            });
        }

        log('[quest-rewards] Parse: ' + rewards.length + ' recompensas encontradas', rewards.length ? 'success' : 'warning');
        return rewards;
    }

    /**
     * Reivindica as recompensas de quests que NÃO causariam overflow no armazém.
     * Se state.questRewards estiver vazio (TTL impediu o pre-fetch), busca o popup
     * ativamente via twFetch antes de tentar reivindicar.
     * Usa twFetch (fetch nativo, credentials:include) — mesmo padrão de bgUpgradeBuilding.
     */
    // ============================================================
    // QUEST REWARDS — abordagem híbrida confirmada pelo spy:
    // GET  ajax=quest_popup  → extrai reward_ids do HTML/DOM
    // POST ajax=claim_reward → body: reward_id={id}&h={csrf}
    // ============================================================
    function bgClaimQuestRewards(villageId, csrf, cachedRewards) {
        log('[quest-rewards] Iniciando coleta (híbrido showDialog + POST)...', 'info');
        HUD.set('build_general', 'running', 'Coletando recompensas de quests...');

        var win    = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        var origin = window.location.origin;
        var claimUrl = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=claim_reward';

        // Extrai reward_ids de um elemento raiz (DOM ou documento parseado)
        function extractRewardIds(root) {
            var ids = [];
            var add = function(v) { if (v && !ids.includes(String(v))) ids.push(String(v)); };
            root.querySelectorAll('input[name="reward_id"]').forEach(function(el) { add(el.value); });
            root.querySelectorAll('[data-reward-id]').forEach(function(el) { add(el.getAttribute('data-reward-id')); });
            root.querySelectorAll('[onclick*="reward_id"]').forEach(function(el) {
                var m = (el.getAttribute('onclick') || '').match(/reward_id[^\d]*(\d+)/i);
                if (m) add(m[1]);
            });
            root.querySelectorAll('a[href*="reward_id="]').forEach(function(el) {
                var m = (el.href || '').match(/reward_id=(\d+)/i);
                if (m) add(m[1]);
            });
            return ids;
        }

        // Passo 1: Chamar Questlines.showDialog (usa XHR nativo do jogo — funciona sem o modal visível)
        // e aguardar tab_loaded['main-tab'] = true (confirma que o HTML do popup está no DOM)
        var dialogPromise = new Promise(function(resolve) {
            if (win.Questlines && typeof win.Questlines.showDialog === 'function') {
                log('[quest-rewards] Questlines.showDialog(0, main-tab)...', 'info');
                win.Questlines.showDialog(0, 'main-tab');
                var elapsed = 0;
                var poll = setInterval(function() {
                    elapsed += 250;
                    var loaded = win.Questlines.tab_loaded && win.Questlines.tab_loaded['main-tab'];
                    if (loaded || elapsed >= 8000) {
                        clearInterval(poll);
                        log('[quest-rewards] tab_loaded=' + !!loaded + ' após ' + elapsed + 'ms', 'info');
                        setTimeout(resolve, 400);
                    }
                }, 250);
            } else {
                log('[quest-rewards] Questlines indisponível, tentando gmGet...', 'warning');
                resolve();
            }
        });

        return dialogPromise.then(function() {
            // Passo 2: Tentar extrair reward_ids do DOM (popup já deve estar no DOM)
            var rewardIds = extractRewardIds(document);
            log('[quest-rewards] DOM scan: ' + rewardIds.length + ' reward_id(s) → [' + rewardIds.join(', ') + ']', 'info');

            // Fallback A: usar cachedRewards do collectVillageState
            if (rewardIds.length === 0 && cachedRewards && cachedRewards.length > 0) {
                rewardIds = cachedRewards.map(function(r) { return String(r.id); }).filter(Boolean);
                log('[quest-rewards] Usando ' + rewardIds.length + ' IDs do pré-fetch.', 'info');
                return Promise.resolve(rewardIds);
            }

            // Fallback B: GET via GM_xmlhttpRequest (mesmo contexto do XHR do jogo)
            if (rewardIds.length === 0) {
                var questUrl = origin + '/game.php?village=' + villageId + '&screen=new_quests&ajax=quest_popup&tab=main-tab&quest=0';
                log('[quest-rewards] Fallback gmGet quest_popup...', 'info');
                return gmGet(questUrl, false).then(function(html) {
                    if (html && !html.includes('"redirect"')) {
                        var doc = new DOMParser().parseFromString(html, 'text/html');
                        rewardIds = extractRewardIds(doc);
                        if (rewardIds.length === 0) {
                            rewardIds = parseQuestRewards(html).map(function(r) { return r.id; }).filter(Boolean);
                        }
                        log('[quest-rewards] gmGet encontrou ' + rewardIds.length + ' reward_id(s).', rewardIds.length ? 'success' : 'warning');
                    } else {
                        log('[quest-rewards] gmGet retornou redirect — sem quests disponíveis.', 'warning');
                    }
                    return rewardIds;
                }).catch(function(e) {
                    log('[quest-rewards] gmGet falhou: ' + e.message, 'error');
                    return [];
                });
            }

            return Promise.resolve(rewardIds);

        }).then(function(rewardIds) {
            if (!rewardIds || rewardIds.length === 0) {
                log('[quest-rewards] Nenhum reward_id encontrado.', 'info');
                HUD.set('build_general', 'idle', 'Sem recompensas disponíveis');
                return { claimed: 0 };
            }

            log('[quest-rewards] Coletando ' + rewardIds.length + ' reward(s) via POST ajax=claim_reward...', 'info');
            var claimed = 0;

            // Passo 3: POST sequencial para cada reward_id (endpoint confirmado pelo spy)
            return rewardIds.reduce(function(chain, rewardId) {
                return chain.then(function() {
                    return new Promise(function(resolve) {
                        setTimeout(function() {
                            var body = 'reward_id=' + encodeURIComponent(rewardId) + '&h=' + encodeURIComponent(csrf);
                            twFetch(claimUrl, 'POST', body, false)
                                .then(function(resp) {
                                    var json = null;
                                    try { json = JSON.parse(resp || '{}'); } catch(e) {}
                                    var ok = json
                                        ? (json.success || json.ok || json.claimed || (!json.error && !json.redirect))
                                        : (resp && !resp.toLowerCase().includes('error'));
                                    if (ok) {
                                        claimed++;
                                        log('[quest-rewards] reward_id=' + rewardId + ' coletado!', 'success');
                                    } else {
                                        log('[quest-rewards] Recusado reward_id=' + rewardId + ': ' + (resp || '').slice(0, 100), 'warning');
                                    }
                                    resolve();
                                })
                                .catch(function(e) {
                                    log('[quest-rewards] Erro POST reward_id=' + rewardId + ': ' + e.message, 'error');
                                    resolve();
                                });
                        }, 600);
                    });
                });
            }, Promise.resolve()).then(function() {
                if (claimed > 0) {
                    log('[quest-rewards] ' + claimed + ' recompensa(s) coletada(s)!', 'success');
                    HUD.set('build_general', 'done', claimed + ' recompensa(s) coletada(s)!');
                    RequestCache.clear();
                } else {
                    HUD.set('build_general', 'idle', 'Sem recompensas aceitas pelo servidor');
                }
                return { claimed: claimed };
            });

        }).catch(function(e) {
            log('[quest-rewards] Erro crítico: ' + e.message, 'error');
            HUD.set('build_general', 'error', 'Erro quest-rewards');
            return { claimed: 0 };
        });
    }

    // ============================================================
    // CÁLCULO DE CONFIANÇA — modo observação
    // task: objeto de tarefa anotado pelo motor
    // state: estado da aldeia (para executabilidade e custo calibrado)
    // Retorna { score: 0-99, razao: string }
    // ============================================================
    function calcularConfianca(task, state) {
        if (!task) return { score: 100, razao: 'Aldeia estável — sem ações pendentes' };

        if (task.id === 'build_rush' || task.id === 'knight_rush') {
            return { score: 98, razao: 'Rush confirmado: obra já em fila, custo zero' };
        }
        if (task.id === 'claim_quest_rewards') {
            return { score: 82, razao: 'Recompensas de quest disponíveis — baixo risco' };
        }
        if (task.id === 'flag') {
            return { score: 88, razao: 'Bandeira não atribuída — ação de baixo risco' };
        }
        if (task.id === 'statue' || task.id === 'knight') {
            return { score: 85, razao: 'Recrutamento disponível e confirmado pelo DOM' };
        }
        if (task.id === 'build_general') {
            var tierBase = { P0: 95, P_NOBLING: 93, P1B: 92, P1C: 90, P2: 85, P3: 75, P3_5: 80, P4: 68 };
            var conf = tierBase[task.tier] || 68;
            var parts = [];

            // Tier label legível
            var tierLabels = {
                P0: 'Pop emergência (95%+)',
                P_NOBLING: 'Nobling prep',
                P1B: 'Armazém crítico (<1.5h)',
                P1C: 'Pop prioridade (92-95%)',
                P2: 'Anti-overflow rápido',
                P3: 'Marco estratégico',
                P3_5: 'Farm preventivo (88-92%)',
                P4: 'Otimização por score'
            };
            parts.push(tierLabels[task.tier] || 'Score geral');

            // Margem sobre o 2º colocado (aplica apenas para P3/P4 onde há competição)
            if ((task.tier === 'P3' || task.tier === 'P4') && task.scoreMargin > 0) {
                var marginBonus = Math.min(15, Math.floor(task.scoreMargin / 5));
                conf += marginBonus;
                if (marginBonus >= 5) parts.push('margem clara (+' + task.scoreMargin.toFixed(1) + ')');
            }

            // Executabilidade confirmada pelo DOM
            if (state.buildCandidatesDOM && state.buildCandidatesDOM.indexOf(task.target) !== -1) {
                conf += 4;
                parts.push('DOM confirma');
            }

            // Confiança na calibração de custo
            try {
                var _ctxKey = getCostContextKey(state.villageId || '');
                var _confData = JSON.parse(GM_getValue('twbot_cost_confidence_' + _ctxKey, '{}') || '{}');
                var _cScore = (_confData[task.target] || {}).score || 0;
                if (_cScore >= 60) { conf += 3; }
                else if (_cScore < 20) { conf -= 8; parts.push('custo estimado (dados escassos)'); }
            } catch(e) {}

            return { score: Math.max(10, Math.min(99, conf)), razao: parts.join(' | ') };
        }
        return { score: 75, razao: 'Ação de suporte' };
    }

    function runChecklist(villageId) {
        villageId = normalizeVillageId(villageId);
        if (!villageId) { log('[runChecklist] villageId inválido, abortando', 'error'); return; }
        HUD.init();

        // Aplicar soft reset se necessário
        VillageMemory.softReset(villageId);

        // Verificar se aldeia pode executar ações (actionLock + cooldown)
        if (!VillageMemory.canAct(villageId)) {
            log('[runChecklist] Aldeia ' + villageId + ' em cooldown ou bloqueada, aguardando...', 'warning');
            setTimeout(() => runChecklist(villageId), CONFIG.mainLoopInterval + Math.floor(Math.random() * 4000) - 2000);
            return;
        }

        // Adquirir lock de ação
        if (!VillageMemory.acquireLock(villageId)) {
            log('[runChecklist] Não foi possível adquirir actionLock', 'warning');
            setTimeout(() => runChecklist(villageId), 3000);
            return;
        }

        collectVillageState(villageId).then(function (state) {
            return motorDeDecisaoMacro(state, villageId).then(function (tasks) {

                var queue = tasks.filter(t => t.action === 'DO');

                // ── MODO OBSERVAÇÃO: analisa, exibe, não executa ──
                if (CONFIG.observationMode) {
                    VillageMemory.releaseLock(villageId);
                    var _obsTask = queue.find(function(t) {
                        return t.id === 'build_general' || t.id === 'build_rush' || t.id === 'knight_rush' || t.id === 'flag' || t.id === 'statue' || t.id === 'knight';
                    });
                    var _conf = calcularConfianca(_obsTask, state);
                    var _alvoNivel = (_obsTask && _obsTask.target && state.niveis)
                        ? (parseInt(state.niveis[_obsTask.target] || 0) + 1) : null;
                    var _altNivel = (_obsTask && _obsTask.alternative && _obsTask.alternative.ed && state.niveis)
                        ? (parseInt(state.niveis[_obsTask.alternative.ed] || 0) + 1) : null;
                    HUD.showObsReport({
                        alvo:        _obsTask ? (_obsTask.target || _obsTask.id) : 'Nenhuma',
                        nivel:       _alvoNivel,
                        confianca:   _conf.score,
                        razao:       _conf.razao,
                        alternativa: _obsTask && _obsTask.alternative ? _obsTask.alternative.ed : null,
                        altNivel:    _altNivel
                    });
                    log('[obs] Análise: ' + (_obsTask ? _obsTask.target || _obsTask.id : 'nada') + ' — confiança ' + _conf.score + '% (' + _conf.razao + ')', 'info');
                    setTimeout(() => runChecklist(villageId), CONFIG.mainLoopInterval + Math.floor(Math.random() * 4000) - 2000);
                    return;
                }

                function execNext(i) {
                    if (i >= queue.length) {
                        // Liberar lock ao finalizar todas as tarefas
                        VillageMemory.releaseLock(villageId);
                        var wait = queue.length > 0 ? 5000 : CONFIG.mainLoopInterval + Math.floor(Math.random() * 4000) - 2000;
                        setTimeout(() => runChecklist(villageId), wait);
                        return;
                    }

                    var task = queue[i];
                    var p = Promise.resolve();

                    if (task.id === 'build_rush') {
                        p = bgBuildRush(villageId, task.orderId, state.csrf)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'rush_' + task.orderId);
                                } else {
                                    VillageMemory.recordError(villageId, 'rush_' + task.orderId, 'rush_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'knight_rush') {
                        p = bgRushKnight(villageId, task.knightId, state.csrf)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'knight_rush_' + task.knightId);
                                } else {
                                    VillageMemory.recordError(villageId, 'knight_rush_' + task.knightId, 'knight_rush_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'build_general') {
                        if (VillageMemory.isTargetBlocked(villageId, task.target)) {
                            log('[executor] Target ' + task.target + ' está bloqueado, pulando', 'warning');
                            p = Promise.resolve(false);
                        } else {
                            p = executeBuildPlan({ villageId: villageId, building: task.target })
                                .then(function(result) { return result && result.ok; });
                        }
                    }
                    else if (task.id === 'statue') {
                        p = bgBuildStatue(villageId, state.csrf)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'statue');
                                } else {
                                    VillageMemory.recordError(villageId, 'statue', 'statue_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'knight') {
                        p = bgRecruitKnight(villageId)
                            .then(function(success) {
                                if (success) {
                                    VillageMemory.recordSuccess(villageId, 'knight');
                                } else {
                                    VillageMemory.recordError(villageId, 'knight', 'knight_fail');
                                }
                                return success;
                            });
                    }
                    else if (task.id === 'flag') {
                        p = bgAssignFlagGhost(villageId, state.phase, task.ctx)
                            .then(function(res) {
                                if (res && res.ok) {
                                    VillageMemory.recordSuccess(villageId, 'flag');
                                } else {
                                    VillageMemory.recordError(villageId, 'flag', 'flag_fail');
                                }
                                return res;
                            });
                    }
                    else if (task.id === 'claim_quest_rewards') {
                        var _questCsrf = state.csrf || '';
                        try {
                            var _qw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                            _questCsrf = (_qw.game_data && _qw.game_data.csrf) || _questCsrf;
                        } catch(e) {}
                        p = bgClaimQuestRewards(villageId, _questCsrf, state.questRewards)
                            .then(function(result) {
                                if (result.claimed > 0) {
                                    VillageMemory.recordSuccess(villageId, 'quest_rewards');
                                    log('[motorDeDecisao] Recursos de quest injetados! Reavaliando no próximo ciclo...', 'success');
                                } else {
                                    log('[motorDeDecisao] Sem recompensas de quest disponíveis no momento.', 'info');
                                }
                                return result;
                            });
                    }

                    p.then(function() {
                        setTimeout(() => execNext(i + 1), 1500);
                    }).catch(function(err) {
                        log('[executor] Erro inesperado: ' + err, 'error');
                        VillageMemory.recordError(villageId, task.target || task.id, 'unexpected_error');
                        setTimeout(() => execNext(i + 1), 1500);
                    });
                }
                execNext(0);
            });
        }).catch(function(err) {
            VillageMemory.releaseLock(villageId);
            log('[runChecklist] Falha crítica: ' + (err && err.message || err), 'error');
            setTimeout(function() { runChecklist(villageId); }, CONFIG.mainLoopInterval + Math.floor(Math.random() * 4000) - 2000);
        });
    }
    // ============================================================
    // SCREEN MODES — interacao direta com o DOM quando usuario JA
    // esta na tela certa (feedback visual + clique nos elementos reais)
    // ============================================================

    function waitAndClick(selector, label, timeoutMs, requireVisible) {
        timeoutMs = timeoutMs || 4000;
        return new Promise(function (resolve, reject) {
            var elapsed = 0;
            var timer = setInterval(function () {
                var el = document.querySelector(selector);
                // requireVisible: ignora elementos pre-renderizados ocultos (offsetParent === null)
                if (el && (!requireVisible || el.offsetParent !== null)) {
                    clearInterval(timer); log('"' + label + '" encontrado.', 'success'); el.click(); resolve(el); return;
                }
                elapsed += 200;
                if (elapsed >= timeoutMs) { clearInterval(timer); reject(new Error('"' + label + '" nao apareceu')); }
            }, 200);
        });
    }

    // --- Bandeiras (tela flags) ---
    function extractAvailableFlags() {
        var flags = [];
        document.querySelectorAll('#flags_container .flag_box:not(.flag_box_empty), .flag_box:not(.flag_box_empty)').forEach(function (box) {
            var type, level;

            // Metodo 1: ID
            var m = (box.id || '').match(/flag_box_(\d+)_(\d+)/);
            if (m) { type = parseInt(m[1]); level = parseInt(m[2]); }

            // Metodo 2: background-image URL (.es / .it / outros servidores sem ID)
            if (!type) {
                var style = box.getAttribute('style') || '';
                var bm = style.match(/flags\/(?:[^/]*\/)?(\d+)_(\d+)\./);
                if (bm) { type = parseInt(bm[1]); level = parseInt(bm[2]); }
            }

            if (!type || !level) return;
            var countEl = box.querySelector('.flag_count');
            var count = countEl ? (parseInt(countEl.textContent.trim()) || 1) : 1;
            if (count < 1) return;
            flags.push({ type: type, level: level, count: count, category: FLAG_TYPE_MAP[type] || 'unknown',
                name: box.getAttribute('data-name') || '', title: box.getAttribute('data-title') || '', element: box });
        });
        return flags;
    }

    function isCurrentFlagAssigned() {
        var el = document.getElementById('current_flag');
        if (!el) return false;
        var style = el.getAttribute('style') || '';
        return !style.includes('display: none') && !style.includes('display:none');
    }

    function highlightBestFlag(element) {
        document.querySelectorAll('.tw-best-flag').forEach(function (el) { el.classList.remove('tw-best-flag'); el.style.outline = ''; el.style.boxShadow = ''; });
        element.classList.add('tw-best-flag');
        element.style.outline = '3px solid #2ecc71';
        element.style.boxShadow = '0 0 12px #2ecc71';
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function assignFlag(element) {
        element.click();
        return waitAndClick('#selected_flag .btn-confirm-yes', 'Ativar')
            .then(function () { return waitAndClick('button.evt-confirm-btn.btn-confirm-yes', 'Confirmar'); })
            .then(function () { log('Bandeira atribuida via DOM!', 'success'); HUD.set('flag', 'done', 'DOM click'); })
            .catch(function (e) { log('Falha DOM flag: ' + e.message, 'error'); });
    }

    // ============================================================
    // SELEÇÃO DE BANDEIRA - APENAS REGRA LOCAL (SEM IA)
    // Decisão baseada em thresholds e score auditável
    // ============================================================
    function selectBestFlagLocal(flags, phase) {
        if (!flags || !flags.length) return null;

        // Pesos por categoria e fase do jogo
        var weights = {
            EARLY:  { resource: 100, population: 80, recruitment: 60, attack: 50, defense: 40, loot: 30, luck: 20, coin: 10 },
            MID:    { attack: 100, loot: 90, recruitment: 80, resource: 70, population: 60, defense: 50, luck: 40, coin: 30 },
            LATE:   { attack: 100, loot: 95, coin: 80, recruitment: 70, resource: 60, population: 50, defense: 40, luck: 30 }
        };

        var w = weights[phase] || weights.EARLY;

        // Calcular score para cada bandeira
        var scored = flags.map(function(f) {
            var baseScore = w[f.category] || 0;
            var levelBonus = f.level * 3;
            var quantityBonus = (f.count || 0) > 1 ? 10 : 0;
            return {
                flag: f,
                score: baseScore + levelBonus + quantityBonus
            };
        });

        // Ordenar por score e retornar a melhor
        scored.sort(function(a, b) { return b.score - a.score; });

        log('[bandeira] Selecionada: ' + scored[0].flag.name + ' (score: ' + scored[0].score + ')', 'info');
        return scored[0].flag;
    }

    function runFlagsMode() {
        log('Modo: Tela de Bandeiras (DOM)');
        var flags = extractAvailableFlags();
        if (!flags.length) { log('Nenhuma bandeira disponivel.', 'warning'); return; }
        var points = getVillagePoints();
        var phase = getGamePhase(points);
        var alreadyAssigned = isCurrentFlagAssigned();
        if (alreadyAssigned) { log('Bandeira ja atribuida.'); return; }

        // Seleção 100% local, sem IA
        var best = selectBestFlagLocal(flags, phase);
        if (!best) return;
        highlightBestFlag(best.element);
        if (CONFIG.autoAssignFlag) {
            HUD.set('flag', 'running', 'DOM: ' + best.name + ' Nv.' + best.level);
            setTimeout(function () { assignFlag(best.element); }, 1500);
        }
    }

    // --- Estatua (tela main) ---
    function runMainMode() {
        log('Modo: Tela Principal (DOM)');
        var btn = document.querySelector('a.btn-build[data-building="statue"]');
        if (btn) {
            log('Construindo estatua via DOM...', 'success');
            HUD.set('statue', 'running', 'DOM click');
            btn.click();
            setTimeout(function () { HUD.set('statue', 'done', 'Clicado'); }, 1000);
        } else {
            log('Estatua nao disponivel para construir agora.');
        }
    }

    // --- Paladino (tela statue) ---
    function runStatueMode() {
        log('Modo: Tela da Estatua (DOM)');
        var selectors =['a.knight_recruit_launch', '.knight_recruit_launch', '#knight_recruit_launch', 'a[class*="recruit"]', 'button[class*="recruit"]'];
        var btn = null;
        for (var i = 0; i < selectors.length; i++) { btn = document.querySelector(selectors[i]); if (btn) break; }

        if (!btn) { log('Paladino ja recrutado ou indisponivel.'); HUD.set('knight', 'skip', 'Nao disponivel'); return; }

        HUD.set('knight', 'running', 'DOM click');
        btn.click();

        waitAndClick('#knight_recruit_confirm, .knight_recruit_confirm, .btn-confirm-yes', 'Confirmar recrutamento', 5000)
            .then(function () { return waitAndClick('.knight_recruit_rush', 'Termina gratis', 4000); })
            .then(function () { log('Paladino recrutado instantaneamente!', 'success'); HUD.set('knight', 'done', 'Instantaneo!'); })
            .catch(function () {
                var rush = document.querySelector('.knight_recruit_rush');
                if (rush) { rush.click(); HUD.set('knight', 'done', 'Instantaneo!'); }
                else { log('Recrutamento iniciado normalmente.', 'success'); HUD.set('knight', 'done', 'Iniciado'); }
            });
    }
    // ============================================================
    // SISTEMA DE GERENCIAMENTO MULTI-VILLAGE
    // ============================================================
    var VillageManager = {
        villages: [],
        currentVillageIndex: 0,
        lastCheckAll: 0,

        // Obter todas as aldeias do jogador
        getAllVillages: function() {
            try {
                if (typeof game_data === 'undefined' || !game_data.player) {
                    return [];
                }

                var villages = [];
                for (var id in game_data.player.villages) {
                    var v = game_data.player.villages[id];
                    villages.push({
                        id: String(v.id),
                        name: v.name,
                        x: v.x,
                        y: v.y,
                        points: parseInt(v.points) || 0,
                        isMain: v.is_main || false
                    });
                }
                return villages;
            } catch (e) {
                log('[VillageManager] Erro ao obter aldeias: ' + e.message, 'error');
                return [];
            }
        },

        // Calcular score de urgência para uma aldeia
        calculateUrgencyScore: function(villageId, state) {
            if (!state) return 50;

            var mem = VillageMemory.get(villageId);
            var _premium = state.premium || {};
            var _rushIds = state.rushIds || [];
            var _knight  = state.knight  || {};
            var _pop = state.populacao || { current: 0, max: 1 };
            var _res = state.recursos  || { wood: 0, stone: 0, iron: 0, max: 1 };

            var bonus   = 0; // acumulado de fatores positivos
            var penalty = 0; // acumulado de fatores negativos

            // 1. População crítica — contribui até 40 pontos de bônus
            var popRatio = _pop.current / (_pop.max || 1);
            if      (popRatio > 0.95) bonus += 40;
            else if (popRatio > 0.90) bonus += 30;
            else if (popRatio > 0.85) bonus += 20;
            else if (popRatio > 0.80) bonus += 10;

            // 2. Armazém cheio — contribui até 35 pontos de bônus
            var resMax = _res.max || 1;
            var resRatio = Math.max(
                _res.wood  / resMax,
                _res.stone / resMax,
                _res.iron  / resMax
            );
            if      (resRatio > 0.95) bonus += 35;
            else if (resRatio > 0.90) bonus += 25;
            else if (resRatio > 0.85) bonus += 15;

            // 3. Fila de construção — contribui até 15 pontos de bônus
            if      (state.filaBuilds === 0 && _premium.ativo) bonus += 15;
            else if (state.filaBuilds < 2)                     bonus += 10;

            // 4. Rush disponível — contribui até 35 pontos de bônus
            if (_rushIds.length > 0) bonus += 20;
            if (state.knightRushId)  bonus += 15;

            // 5. Bandeira não atribuída — contribui 10 pontos de bônus
            if (!state.flagAssigned) bonus += 10;

            // 6. Paladino pronto para recrutar — contribui 15 pontos de bônus
            if (_knight.canRecruit && !_knight.isRecruiting) bonus += 15;

            // 7. Perfil econômico com recursos baixos — contribui 15 pontos de bônus
            if (mem.profile === VillageMemory.PROFILES.ECONOMIC && resRatio < 0.5) bonus += 15;

            // 8. Perfil militar com fila vazia — contribui 10 pontos de bônus
            if (mem.profile === VillageMemory.PROFILES.MILITARY && state.filaBuilds === 0) bonus += 10;

            // 9. Em cooldown — 30 pontos de penalidade
            if (mem.cooldownUntil && Date.now() < mem.cooldownUntil) penalty += 30;

            // 10. Muitas falhas consecutivas — até 20 pontos de penalidade
            if      (mem.consecutiveFails >= 3) penalty += 20;
            else if (mem.consecutiveFails >= 2) penalty += 10;

            // 11. Ação em progresso — 25 pontos de penalidade
            if (mem.actionLock && Date.now() < mem.actionLock) penalty += 25;

            // Normalização: mapeia bônus [0..175] → [0..50] e penalidade [0..75] → [0..50]
            // Resultado sempre cabe em [0, 100] por construção; clamp é apenas segurança.
            var MAX_BONUS   = 175; // 40+35+15+20+15+10+15+15+10
            var MAX_PENALTY =  75; // 30+20+25
            var score = 50
                + Math.round((bonus   / MAX_BONUS)   * 50)
                - Math.round((penalty / MAX_PENALTY) * 50);

            return Math.max(0, Math.min(100, score));
        },

        // Classificar aldeias por urgência
        rankVillages: function() {
            var self = this;
            var ranked = [];

            this.villages.forEach(function(v) {
                // Tentar obter estado salvo ou calcular score básico
                var mem = VillageMemory.get(v.id);
                var rawState = GM_getValue('village_last_state_' + v.id, null);
                var lastState = null;
                if (rawState) {
                    try { lastState = typeof rawState === 'string' ? JSON.parse(rawState) : rawState; } catch(e) {}
                }
                var score = self.calculateUrgencyScore(v.id, lastState);

                ranked.push({
                    village: v,
                    score: score,
                    profile: mem.profile,
                    lastSuccess: mem.lastSuccess,
                    inCooldown: mem.cooldownUntil && Date.now() < mem.cooldownUntil,
                    actionLock: mem.actionLock
                });
            });

            // Ordenar por score (maior urgência primeiro)
            ranked.sort(function(a, b) { return b.score - a.score; });

            return ranked;
        },

        // Obter próxima aldeia para processamento
        getNextVillage: function() {
            var ranked = this.rankVillages();
            if (ranked.length === 0) return null;

            // Retorna a aldeia com maior urgência
            return ranked[0].village;
        },

        // Atualizar lista de aldeias
        refreshVillages: function() {
            this.villages = this.getAllVillages();
            log('[VillageManager] ' + this.villages.length + ' aldeias encontradas', 'info');

            // Inicializar ou re-detectar perfil para aldeias (re-detecta a cada 2h mesmo se não BALANCED,
            // pois a aldeia pode ter mudado de foco desde a última classificação)
            var self = this;
            var REDETECT_INTERVAL_MS = 7200000; // 2 horas
            this.villages.forEach(function(v) {
                var mem = VillageMemory.get(v.id);
                var lastDetectionTs = GM_getValue('village_profile_ts_' + v.id, 0);
                var needsDetection  = !mem.profile
                    || mem.profile === VillageMemory.PROFILES.BALANCED
                    || (Date.now() - lastDetectionTs) > REDETECT_INTERVAL_MS;

                if (needsDetection) {
                    var rawSavedState = GM_getValue('village_last_state_' + v.id, null);
                    var savedState = null;
                    if (rawSavedState) {
                        try { savedState = typeof rawSavedState === 'string' ? JSON.parse(rawSavedState) : rawSavedState; } catch (e) {}
                    }
                    var detectedProfile = self.autoDetectProfile(savedState);
                    if (detectedProfile !== mem.profile) {
                        log('[VillageManager] Perfil de ' + v.id + ' atualizado: ' + mem.profile + ' → ' + detectedProfile, 'info');
                        VillageMemory.setProfile(v.id, detectedProfile);
                    }
                    GM_setValue('village_profile_ts_' + v.id, Date.now());
                }
            });

            return this.villages;
        },

        // Auto-detectar perfil da aldeia a partir do estado salvo completo.
        // Aceita o objeto state (com niveis, recursos, populacao, phase) — NÃO os níveis isolados.
        autoDetectProfile: function(state) {
            if (!state || !state.niveis) return VillageMemory.PROFILES.BALANCED;

            var lvl   = state.niveis;
            var phase = state.phase || 'EARLY';
            var _res  = state.recursos  || { wood: 0, stone: 0, iron: 0, max: 1 };
            var _pop  = state.populacao || { current: 0, max: 1 };

            // Pontuação base pela composição de edifícios
            var militaryScore = (parseInt(lvl.barracks) || 0)
                + (parseInt(lvl.stable) || 0) * 1.2
                + (parseInt(lvl.smith)  || 0);
            var economicScore = (parseInt(lvl.wood)    || 0)
                + (parseInt(lvl.stone)   || 0)
                + (parseInt(lvl.iron)    || 0) * 1.1
                + (parseInt(lvl.storage) || 0);
            var defenseScore  = (parseInt(lvl.wall)   || 0)
                + (parseInt(lvl.hide)    || 0)
                + (parseInt(lvl.church)  || 0);

            // Fator 1 — Nível do HQ: HQ alto acelera todas as obras → tendência BALANCED
            var hqLevel = parseInt(lvl.main) || 0;
            var hqBonus = HQ_PRODUCTIVITY_BONUS[Math.min(hqLevel, 25)] || 0;
            if (hqLevel >= 10) {
                economicScore *= (1 + hqBonus * 0.3);
                militaryScore *= (1 + hqBonus * 0.3);
            }

            // Fator 2 — Pressão de armazém: recursos constantemente cheios → econômico
            var resMax   = _res.max || 1;
            var resRatio = Math.max(_res.wood / resMax, _res.stone / resMax, _res.iron / resMax);
            if (resRatio > 0.9) economicScore *= 1.2;

            // Fator 3 — Fase: amplificadores de score E thresholds de decisão específicos por fase.
            // EARLY usa thresholds reduzidos para classificar mais cedo e evitar ficar em BALANCED
            // desnecessariamente enquanto a aldeia já demonstra especialização clara.
            var threshMilitary, threshEconomic, threshDefense;
            if (phase === 'EARLY') {
                economicScore  *= 1.4; // Forte viés econômico em EARLY (era 1.2)
                militaryScore  *= 1.1; // Amplifica sinais militares incipientes
                // Sinal de especialização precoce: barracks/smith já evoluídos indicam MILITARY
                var earlyMilSignal = (parseInt(lvl.barracks) || 0) >= 3 || (parseInt(lvl.smith) || 0) >= 2;
                if (earlyMilSignal) militaryScore *= 1.2;
                // Thresholds reduzidos → decisão mais agressiva na fase inicial
                threshMilitary = 1.1;  // era 1.3
                threshEconomic = 1.2;  // era 1.5
                threshDefense  = 1.05; // era 1.2 / 1.1
            } else if (phase === 'MID') {
                militaryScore  *= 1.1;
                threshMilitary = 1.2;
                threshEconomic = 1.35;
                threshDefense  = 1.15;
            } else { // LATE — mantém comportamento conservador original
                militaryScore  *= 1.3;
                threshMilitary = 1.3;
                threshEconomic = 1.5;
                threshDefense  = 1.2;
            }

            log('[autoDetectProfile] phase=' + phase + ' mil=' + militaryScore.toFixed(1) + ' eco=' + economicScore.toFixed(1) + ' def=' + defenseScore.toFixed(1) + ' threshMil=' + threshMilitary + ' threshEco=' + threshEconomic, 'debug');

            // Decisão com thresholds calibrados por fase
            if (militaryScore > economicScore * threshMilitary && militaryScore > defenseScore * threshDefense) {
                return VillageMemory.PROFILES.MILITARY;
            } else if (economicScore > militaryScore * threshEconomic && economicScore > defenseScore * threshDefense) {
                return VillageMemory.PROFILES.ECONOMIC;
            } else if (defenseScore > militaryScore * threshDefense && defenseScore > economicScore * (threshDefense * 0.9)) {
                return VillageMemory.PROFILES.SUPPORT;
            }

            return VillageMemory.PROFILES.BALANCED;
        },

        // Salvar estado da aldeia para ranking futuro (apenas campos serializáveis e compactos)
        saveVillageState: function(villageId, state) {
            if (!state) return;
            var compact = {
                populacao:    state.populacao,
                recursos:     state.recursos,
                niveis:       state.niveis,
                filaBuilds:   state.filaBuilds,
                rushIds:      state.rushIds,
                knightRushId: state.knightRushId,
                premium:      state.premium,
                phase:        state.phase,
                flagAssigned: state.flagAssigned,
                canBuildStatue: state.canBuildStatue,
                knight: state.knight ? {
                    canRecruit:   state.knight.canRecruit,
                    isPresent:    state.knight.isPresent,
                    isRecruiting: state.knight.isRecruiting,
                    statueExists: state.knight.statueExists
                } : null
            };
            GM_setValue('village_last_state_' + villageId, JSON.stringify(compact));
        },

        // Mostrar status do gerenciamento multi-village
        getStatus: function() {
            var ranked = this.rankVillages();
            var status = ranked.map(function(r, i) {
                return (i+1) + '. ' + r.village.name + ' (score: ' + r.score + ', perfil: ' + r.profile + ')';
            });
            return status.join('\n');
        }
    };

    // ============================================================
    // INIT
    // ============================================================
    function init() {
        // Iframe do bot (knight e flag usam o mesmo name): o opener controla os cliques
        if (window.name === 'tw-bot-knight') {
            log('[init] Executando em iframe bot — skip auto actions');
            return;
        }
        log('TW Smart Automation v8.0 - Multi-Village Manager iniciado.');

        // Limpeza periódica do cache — independente do ciclo de coleta de estado
        setInterval(function() { RequestCache.cleanup(); }, CONFIG.cacheExpiryMs * 4);

        // Refresh inicial das aldeias
        VillageManager.refreshVillages();

        var villageId = normalizeVillageId(getCurrentVillageId());
        var screen = getScreenParam();

        // Background checklist roda em QUALQUER tela
        if (villageId) {
            // Salvar estado inicial para ranking
            collectVillageState(villageId).then(function(state) {
                VillageManager.saveVillageState(villageId, state);
            });

            setTimeout(function () { runChecklist(villageId); }, CONFIG.checklistDelay);
        } else {
            // Sem village ID: mostra HUD vazio aguardando
            HUD.init();
        }

        // Modos de tela direta: feedback visual adicional quando usuario JA esta na tela
        // O checklist ja cuida da logica; os modos abaixo adicionam interacao DOM
        if (screen === 'flags') {
            var wait = setInterval(function () {
                if (document.getElementById('flags_container')) { clearInterval(wait); runFlagsMode(); }
            }, 200);
            setTimeout(function () { clearInterval(wait); }, 10000);

        } else if (screen === 'statue') {
            runStatueMode();

        } else if (screen === 'main') {
            setTimeout(runMainMode, 1000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 800); });
    } else {
        setTimeout(init, 800);
    }

    window.TWBot = {
        config: CONFIG,
        hud: HUD,
        villageManager: VillageManager,
        memory: VillageMemory,
        // API para definir perfil manualmente por aldeia
        setVillageProfile: function(villageId, profile) {
            VillageMemory.setProfile(villageId, profile);
        },
        // API para obter ranking de urgência
        getUrgencyRanking: function() {
            return VillageManager.rankVillages();
        },
        // API para forçar refresh das aldeias
        refreshVillages: function() {
            return VillageManager.refreshVillages();
        },
        // Define custo de um edifício para este mundo e persiste para a próxima sessão.
        // Uso: TWBot.setCostOverride('barracks', [90, 130, 0, 130])
        setCostOverride: function(building, costsArray) {
            if (!building || !Array.isArray(costsArray) || costsArray.length < 3) {
                console.error('[TWBot] setCostOverride: espera (string, [w, s, i, t])');
                return;
            }
            TW_BUILDING_COSTS[building] = costsArray;
            try {
                var raw = GM_getValue('twbot_costs_override', null);
                var stored = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
                stored[building] = costsArray;
                GM_setValue('twbot_costs_override', JSON.stringify(stored));
                // Override manual = confiança máxima para este edifício
                var _wId    = (typeof game_data !== 'undefined' && game_data.world)
                    ? game_data.world : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                var ctxKey  = getCostContextKey(_wId);
                var confKey = 'twbot_cost_confidence_' + ctxKey;
                var conf = {}; try { conf = JSON.parse(GM_getValue(confKey, null) || '{}'); } catch(e) {}
                conf[building] = { score: 100, hits: 1, source: 'override', ts: Date.now() };
                GM_setValue(confKey, JSON.stringify(conf));
                console.log('[TWBot] Override salvo para ' + building + ': ' + JSON.stringify(costsArray) + ' (confiança: 100)');
            } catch (e) { console.error('[TWBot] Erro ao salvar override: ' + e.message); }
        },
        // Retorna os overrides manuais ativos em relação aos defaults.
        getCostOverrides: function() {
            try {
                var raw = GM_getValue('twbot_costs_override', null);
                return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            } catch (e) { return {}; }
        },
        // Retorna confidence score por edifício para o contexto atual (mundo+mercado+idioma).
        // Scores: 0-39 = fallback estático; 40-69 = parcialmente calibrado; 70-100 = calibrado por DOM.
        getCostConfidence: function() {
            try {
                var _wId   = (typeof game_data !== 'undefined' && game_data.world)
                    ? game_data.world : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                var ctxKey = getCostContextKey(_wId);
                var raw    = GM_getValue('twbot_cost_confidence_' + ctxKey, null);
                return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            } catch(e) { return {}; }
        },
        // Força re-scraping de custos na próxima visita a screen=main.
        // Útil após mudança de mundo, idioma ou atualização do jogo.
        clearCostCache: function() {
            try {
                var _wId   = (typeof game_data !== 'undefined' && game_data.world)
                    ? game_data.world : window.location.hostname.replace(/[^a-z0-9]/gi, '_');
                var ctxKey = getCostContextKey(_wId);
                GM_setValue('twbot_costs_scraped_' + ctxKey, 0);
                GM_setValue('twbot_force_rescrape', 1);
                console.log('[TWBot] Cache de custos limpo para contexto "' + ctxKey + '". Re-scraping na próxima visita.');
            } catch(e) { console.error('[TWBot] Erro em clearCostCache: ' + e.message); }
        }
    };

})();
