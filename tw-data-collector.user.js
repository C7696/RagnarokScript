// ==UserScript==
// @name         Tribal Wars Bot - Data Collector (BR136)
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Módulo profissional de coleta de dados para Tribal Wars BR136
// @author       TWBot Dev Team
// @match        https://br136.tribalwars.com.br/*
// @match        https://br136.tribalwars.com.br/game.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_log
// @connect      br.twstats.com
// @run-at       document-end
// @noframes     true
// ==/UserScript==

(function() {
  'use strict';

  // ============================================================================
  // CONFIGURAÇÃO GLOBAL
  // ============================================================================
  const CONFIG = {
    DEBUG: GM_getValue('twbot_debug', false),
    CACHE_TTL: {
      RESOURCES: 5000,        // 5 segundos
      PRODUCTION: 10000,      // 10 segundos
      BUILDINGS: 15000,       // 15 segundos
      QUEUE: 3000,            // 3 segundos
      WORLD_CONFIG: 300000,   // 5 minutos
      UNIT_CONFIG: 300000,    // 5 minutos
      BUILDING_CONFIG: 300000 // 5 minutos
    },
    STORAGE_PREFIX: 'twbot_',
    MAX_HISTORY_ENTRIES: 1000,
    TICK_INTERVAL: 10000,     // 10 segundos
    OBSERVER_DEBOUNCE: 500    // 500ms debounce para observers
  };

  // ============================================================================
  // UTILITÁRIOS
  // ============================================================================
  const Utils = {
    log(message, data = null, level = 'info') {
      if (!CONFIG.DEBUG && level === 'debug') return;
      
      const timestamp = new Date().toISOString().substr(11, 8);
      const prefix = `[TWBot ${timestamp}]`;
      
      if (level === 'error') {
        console.error(`${prefix} [ERROR] ${message}`, data || '');
      } else if (level === 'warn') {
        console.warn(`${prefix} [WARN] ${message}`, data || '');
      } else if (level === 'debug') {
        console.log(`${prefix} [DEBUG] ${message}`, data || '');
      } else {
        console.log(`${prefix} ${message}`, data || '');
      }
      
      // Armazena log para exportação
      this.saveLog({ timestamp, level, message, data });
    },

    logs: [],
    saveLog(logEntry) {
      this.logs.push(logEntry);
      if (this.logs.length > CONFIG.MAX_HISTORY_ENTRIES) {
        this.logs.shift();
      }
    },

    getLogs() {
      return [...this.logs];
    },

    exportLogs() {
      const blob = new Blob([JSON.stringify(this.logs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `twbot-logs-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    // QuerySelector seguro que não throwa erro
    safeQuerySelector(selector, context = document) {
      try {
        return context.querySelector(selector) || null;
      } catch (e) {
        this.log(`Erro no seletor: ${selector}`, e, 'error');
        return null;
      }
    },

    // QuerySelectorAll seguro
    safeQuerySelectorAll(selector, context = document) {
      try {
        return Array.from(context.querySelectorAll(selector) || []);
      } catch (e) {
        this.log(`Erro no seletor (all): ${selector}`, e, 'error');
        return [];
      }
    },

    // Parse de número brasileiro (1.000 -> 1000)
    parseBrazilianNumber(str) {
      if (!str) return 0;
      if (typeof str === 'number') return str;
      
      // Remove pontos de milhar e troca vírgula por ponto
      const cleaned = str.toString()
        .replace(/\./g, '')      // Remove separador de milhar
        .replace(',', '.')       // Troca vírgula decimal por ponto
        .replace(/[^\d.-]/g, ''); // Remove caracteres não numéricos
      
      const num = parseFloat(cleaned);
      return isNaN(num) ? 0 : num;
    },

    // Parse de tempo no formato "0:00:02" para segundos
    parseTimeToSeconds(timeStr) {
      if (!timeStr) return 0;
      
      const parts = timeStr.trim().split(':').reverse();
      let seconds = 0;
      
      parts.forEach((part, index) => {
        const num = parseInt(part, 10);
        if (!isNaN(num)) {
          seconds += num * Math.pow(60, index);
        }
      });
      
      return seconds;
    },

    // Cache com TTL
    createCache(ttl = 5000) {
      let cache = null;
      let expiry = 0;

      return {
        get(key = 'default') {
          if (cache !== null && Date.now() < expiry) {
            return cache;
          }
          return null;
        },
        set(value, key = 'default') {
          cache = value;
          expiry = Date.now() + ttl;
        },
        invalidate() {
          cache = null;
          expiry = 0;
        },
        isExpired() {
          return Date.now() >= expiry;
        }
      };
    },

    // Debounce para callbacks
    debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    },

    // Retry automático
    async retry(fn, maxRetries = 3, delay = 1000) {
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await fn();
        } catch (e) {
          if (i === maxRetries - 1) throw e;
          this.log(`Retry ${i + 1}/${maxRetries}`, e, 'warn');
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    },

    // XPath helper
    getElementByXPath(xpath) {
      try {
        const result = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        return result.singleNodeValue || null;
      } catch (e) {
        this.log(`Erro no XPath: ${xpath}`, e, 'error');
        return null;
      }
    }
  };

  // ============================================================================
  // COLETOR DE RECURSOS
  // ============================================================================
  const ResourceCollector = {
    cache: {
      resources: Utils.createCache(CONFIG.CACHE_TTL.RESOURCES),
      production: Utils.createCache(CONFIG.CACHE_TTL.PRODUCTION),
      storage: Utils.createCache(CONFIG.CACHE_TTL.RESOURCES),
      population: Utils.createCache(CONFIG.CACHE_TTL.RESOURCES)
    },

    getCurrentResources() {
      const cached = this.cache.resources.get();
      if (cached) return cached;

      const result = {
        wood: 0,
        clay: 0,
        iron: 0,
        storage: 0
      };

      try {
        // Estratégia 1: IDs diretos (mais comum)
        const woodEl = Utils.safeQuerySelector('#wood');
        const stoneEl = Utils.safeQuerySelector('#stone');
        const ironEl = Utils.safeQuerySelector('#iron');
        const storageEl = Utils.safeQuerySelector('#storage');

        if (woodEl) result.wood = Utils.parseBrazilianNumber(woodEl.textContent);
        if (stoneEl) result.clay = Utils.parseBrazilianNumber(stoneEl.textContent);
        if (ironEl) result.iron = Utils.parseBrazilianNumber(ironEl.textContent);
        if (storageEl) result.storage = Utils.parseBrazilianNumber(storageEl.textContent);

        // Estratégia 2: Fallback por data-title
        if (result.wood === 0) {
          const woodByTitle = Utils.safeQuerySelector('[data-title*="Madeira"]');
          if (woodByTitle) {
            result.wood = Utils.parseBrazilianNumber(woodByTitle.textContent);
          }
        }

        if (result.clay === 0) {
          const clayByTitle = Utils.safeQuerySelector('[data-title*="Argila"]');
          if (clayByTitle) {
            result.clay = Utils.parseBrazilianNumber(clayByTitle.textContent);
          }
        }

        if (result.iron === 0) {
          const ironByTitle = Utils.safeQuerySelector('[data-title*="Ferro"]');
          if (ironByTitle) {
            result.iron = Utils.parseBrazilianNumber(ironByTitle.textContent);
          }
        }

        // Estratégia 3: XPath como último fallback
        if (result.wood === 0) {
          const woodXPath = Utils.getElementByXPath('//span[@id="wood"]');
          if (woodXPath) {
            result.wood = Utils.parseBrazilianNumber(woodXPath.textContent);
          }
        }

        this.cache.resources.set(result);
        Utils.log('Recursos coletados', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar recursos', e, 'error');
      }

      return result;
    },

    getProductionRates() {
      const cached = this.cache.production.get();
      if (cached) return cached;

      const result = {
        wood: 0,
        clay: 0,
        iron: 0
      };

      try {
        // Busca na tabela de produção da página principal
        const prodContainer = Utils.safeQuerySelector('#show_prod');
        
        if (prodContainer) {
          const rows = Utils.safeQuerySelectorAll('#show_prod table tbody tr', prodContainer);
          
          if (rows.length >= 3) {
            // Madeira (linha 1)
            const woodCell = Utils.safeQuerySelector('td:nth-of-type(2)', rows[0]);
            if (woodCell) {
              const text = woodCell.textContent;
              const match = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)/);
              if (match) {
                result.wood = Utils.parseBrazilianNumber(match[1]);
              }
            }

            // Argila (linha 2)
            const clayCell = Utils.safeQuerySelector('td:nth-of-type(2)', rows[1]);
            if (clayCell) {
              const text = clayCell.textContent;
              const match = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)/);
              if (match) {
                result.clay = Utils.parseBrazilianNumber(match[1]);
              }
            }

            // Ferro (linha 3)
            const ironCell = Utils.safeQuerySelector('td:nth-of-type(2)', rows[2]);
            if (ironCell) {
              const text = ironCell.textContent;
              const match = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)/);
              if (match) {
                result.iron = Utils.parseBrazilianNumber(match[1]);
              }
            }
          }
        }

        // Fallback: tentar extrair do data-title dos recursos
        if (result.wood === 0 || result.clay === 0 || result.iron === 0) {
          const headerInfo = Utils.safeQuerySelector('#header_info');
          if (headerInfo) {
            const titles = Utils.safeQuerySelectorAll('[data-title*="por hora"]', headerInfo);
            titles.forEach(el => {
              const title = el.getAttribute('data-title') || '';
              const text = el.textContent;
              const match = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)/);
              
              if (match) {
                const value = Utils.parseBrazilianNumber(match[1]);
                if (title.includes('Madeira')) result.wood = value;
                else if (title.includes('Argila')) result.clay = value;
                else if (title.includes('Ferro')) result.iron = value;
              }
            });
          }
        }

        this.cache.production.set(result);
        Utils.log('Taxas de produção coletadas', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar taxas de produção', e, 'error');
      }

      return result;
    },

    getStorageCapacity() {
      const cached = this.cache.storage.get();
      if (cached !== null) return cached;

      let result = 0;

      try {
        // Estratégia 1: ID direto
        const storageEl = Utils.safeQuerySelector('#storage');
        if (storageEl) {
          const title = storageEl.getAttribute('data-title') || '';
          const match = title.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)/);
          if (match) {
            result = Utils.parseBrazilianNumber(match[1]);
          }
        }

        // Estratégia 2: Buscar pelo texto "Capacidade"
        if (result === 0) {
          const capacityEl = Utils.safeQuerySelector('[data-title*="Capacidade"]');
          if (capacityEl) {
            const title = capacityEl.getAttribute('data-title') || '';
            const match = title.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)/);
            if (match) {
              result = Utils.parseBrazilianNumber(match[1]);
            }
          }
        }

        this.cache.storage.set(result);
        Utils.log('Capacidade de armazenamento', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar capacidade', e, 'error');
      }

      return result;
    },

    getPopulation() {
      const cached = this.cache.population.get();
      if (cached) return cached;

      const result = {
        current: 0,
        max: 0
      };

      try {
        // Estratégia 1: ID direto para população atual
        const popCurrentEl = Utils.safeQuerySelector('#pop_current_label');
        if (popCurrentEl) {
          result.current = Utils.parseBrazilianNumber(popCurrentEl.textContent);
        }

        // Estratégia 2: Buscar fazenda para população máxima
        const farmEl = Utils.safeQuerySelector('[data-title*="Fazenda"]');
        if (farmEl) {
          const title = farmEl.getAttribute('data-title') || '';
          // Formato esperado: "Fazenda - X/Y"
          const match = title.match(/(\d{1,3}(?:\.\d{3})*)\s*\/\s*(\d{1,3}(?:\.\d{3})*)/);
          if (match) {
            result.current = Utils.parseBrazilianNumber(match[1]);
            result.max = Utils.parseBrazilianNumber(match[2]);
          }
        }

        // Fallback: tentar extrair de box-item
        if (result.max === 0) {
          const boxItems = Utils.safeQuerySelectorAll('.box-item');
          boxItems.forEach(item => {
            const title = item.getAttribute('data-title') || '';
            if (title.includes('Fazenda')) {
              const match = title.match(/(\d+)\s*\/\s*(\d+)/);
              if (match) {
                result.current = parseInt(match[1], 10);
                result.max = parseInt(match[2], 10);
              }
            }
          });
        }

        this.cache.population.set(result);
        Utils.log('População coletada', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar população', e, 'error');
      }

      return result;
    },

    getAllResourceData() {
      return {
        ...this.getCurrentResources(),
        production: this.getProductionRates(),
        population: this.getPopulation()
      };
    },

    invalidateCache() {
      Object.values(this.cache).forEach(cache => cache.invalidate());
      Utils.log('Cache de recursos invalidado', null, 'debug');
    }
  };

  // ============================================================================
  // COLETOR DE EDIFÍCIOS
  // ============================================================================
  const BuildingCollector = {
    cache: {
      buildings: Utils.createCache(CONFIG.CACHE_TTL.BUILDINGS),
      unmet: Utils.createCache(CONFIG.CACHE_TTL.BUILDINGS),
      queue: Utils.createCache(CONFIG.CACHE_TTL.QUEUE)
    },

    buildingTypes: [
      'main', 'place', 'statue', 'wood', 'stone', 'iron', 'farm', 'storage',
      'hide', 'barracks', 'stable', 'garage', 'watchtower', 'academy', 'smith',
      'market', 'wall'
    ],

    getBuildingLevels() {
      const cached = this.cache.buildings.get();
      if (cached) return cached;

      const result = {};

      try {
        const buildingsTable = Utils.safeQuerySelector('#buildings');
        
        if (buildingsTable) {
          this.buildingTypes.forEach(type => {
            const row = Utils.safeQuerySelector(`tr#main_buildrow_${type}`, buildingsTable);
            
            if (row) {
              const levelCell = Utils.safeQuerySelector('td:nth-of-type(1) span', row);
              if (levelCell) {
                const text = levelCell.textContent;
                const match = text.match(/Nível\s+(\d+)/i);
                result[type] = match ? parseInt(match[1], 10) : 0;
              } else {
                result[type] = 0;
              }
            } else {
              result[type] = 0;
            }
          });
        } else {
          // Se não houver tabela, todos os edifícios são 0
          this.buildingTypes.forEach(type => {
            result[type] = 0;
          });
        }

        this.cache.buildings.set(result);
        Utils.log('Níveis de edifícios coletados', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar níveis de edifícios', e, 'error');
        // Retorna valores padrão em caso de erro
        this.buildingTypes.forEach(type => {
          result[type] = 0;
        });
      }

      return result;
    },

    getAvailableBuildings() {
      const result = [];

      try {
        const buildingsTable = Utils.safeQuerySelector('#buildings');
        
        if (buildingsTable) {
          const rows = Utils.safeQuerySelectorAll('tbody tr', buildingsTable);
          
          rows.forEach(row => {
            const id = row.id;
            if (id && id.startsWith('main_buildrow_')) {
              const type = id.replace('main_buildrow_', '');
              const levelCell = Utils.safeQuerySelector('td:nth-of-type(1) span', row);
              
              if (levelCell) {
                const text = levelCell.textContent;
                const match = text.match(/Nível\s+(\d+)/i);
                
                result.push({
                  type: type,
                  level: match ? parseInt(match[1], 10) : 0,
                  built: match !== null
                });
              }
            }
          });
        }

        Utils.log('Edifícios disponíveis', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar edifícios disponíveis', e, 'error');
      }

      return result;
    },

    getUnavailableBuildings() {
      const cached = this.cache.unmet.get();
      if (cached) return cached;

      const result = [];

      try {
        const unmetTable = Utils.safeQuerySelector('#buildings_unmet');
        
        if (unmetTable) {
          const rows = Utils.safeQuerySelectorAll('tbody tr', unmetTable);
          
          rows.forEach(row => {
            const nameCell = Utils.safeQuerySelector('td:nth-of-type(1)', row);
            const reqCell = Utils.safeQuerySelector('td:nth-of-type(2)', row);
            
            if (nameCell) {
              result.push({
                name: nameCell.textContent.trim(),
                requirements: reqCell ? reqCell.textContent.trim() : ''
              });
            }
          });
        }

        this.cache.unmet.set(result);
        Utils.log('Edifícios indisponíveis', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar edifícios indisponíveis', e, 'error');
      }

      return result;
    },

    getBuildingQueue() {
      const cached = this.cache.queue.get();
      if (cached) return cached;

      const result = [];

      try {
        const queueBody = Utils.safeQuerySelector('#buildqueue');
        
        if (queueBody) {
          const rows = Utils.safeQuerySelectorAll('tr', queueBody);
          
          // Pula o header (primeira linha)
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            
            const buildingCell = Utils.safeQuerySelector('td:nth-of-type(1)', row);
            const levelCell = Utils.safeQuerySelector('td:nth-of-type(1) .lvl', row);
            const timeCell = Utils.safeQuerySelector('td:nth-of-type(2)', row);
            
            if (buildingCell) {
              const buildingText = buildingCell.textContent.trim();
              const levelMatch = buildingText.match(/(\w+)\s+\(?nível\s+(\d+)\)?/i);
              
              let building = buildingText;
              let level = 0;
              
              if (levelMatch) {
                building = levelMatch[1].toLowerCase();
                // Mapeia nomes em português para tipos internos
                const nameMap = {
                  'edificio': 'main',
                  'praça': 'place',
                  'estátua': 'statue',
                  'serraria': 'wood',
                  'poço': 'stone',
                  'mina': 'iron',
                  'fazenda': 'farm',
                  'armazém': 'storage',
                  'esconderijo': 'hide',
                  'quartel': 'barracks',
                  'estábulo': 'stable',
                  'oficina': 'garage',
                  'posto': 'watchtower',
                  'academia': 'academy',
                  'ferreiro': 'smith',
                  'mercado': 'market',
                  'muralha': 'wall'
                };
                building = nameMap[building] || building;
                level = parseInt(levelMatch[2], 10);
              }
              
              let timeRemaining = 0;
              if (timeCell) {
                const timeText = timeCell.textContent.trim();
                timeRemaining = Utils.parseTimeToSeconds(timeText);
              }
              
              result.push({
                building: building,
                level: level,
                timeRemaining: timeRemaining
              });
            }
          }
        }

        this.cache.queue.set(result);
        Utils.log('Fila de construção', result, 'debug');
      } catch (e) {
        Utils.log('Erro ao coletar fila de construção', e, 'error');
      }

      return result;
    },

    getBuildingLevel(type) {
      const levels = this.getBuildingLevels();
      return {
        level: levels[type] || 0,
        built: (levels[type] || 0) > 0
      };
    },

    getAllBuildings() {
      return {
        levels: this.getBuildingLevels(),
        available: this.getAvailableBuildings(),
        unavailable: this.getUnavailableBuildings(),
        queue: this.getBuildingQueue()
      };
    },

    invalidateCache() {
      Object.values(this.cache).forEach(cache => cache.invalidate());
      Utils.log('Cache de edifícios invalidado', null, 'debug');
    }
  };

  // ============================================================================
  // COLETOR DE FILA DE CONSTRUÇÃO (separado para compatibilidade)
  // ============================================================================
  const ConstructionQueueCollector = {
    getQueue() {
      return BuildingCollector.getBuildingQueue();
    },

    getTotalQueueTime() {
      const queue = this.getQueue();
      return queue.reduce((total, item) => total + item.timeRemaining, 0);
    },

    isQueueEmpty() {
      return this.getQueue().length === 0;
    },

    getNextBuilding() {
      const queue = this.getQueue();
      return queue.length > 0 ? queue[0] : null;
    }
  };

  // ============================================================================
  // CONFIGURAÇÃO DO MUNDO
  // ============================================================================
  const WorldConfig = {
    cache: {
      settings: Utils.createCache(CONFIG.CACHE_TTL.WORLD_CONFIG),
      units: Utils.createCache(CONFIG.CACHE_TTL.UNIT_CONFIG),
      buildings: Utils.createCache(CONFIG.CACHE_TTL.BUILDING_CONFIG)
    },

    config: {
      worldSpeed: 1,
      unitSpeed: 1,
      moralEnabled: true,
      nightBonusEnabled: true,
      units: {},
      buildings: {}
    },

    async loadWorldSettings() {
      const cached = this.cache.settings.get();
      if (cached) {
        this.config = { ...this.config, ...cached };
        return this.config;
      }

      try {
        Utils.log('Carregando configurações do mundo...', null, 'debug');

        // Tenta extrair da própria página do jogo primeiro
        const gameSpeedEl = Utils.safeQuerySelector('[data-title*="velocidade"]');
        if (gameSpeedEl) {
          const text = gameSpeedEl.textContent;
          const match = text.match(/(\d+(?:,\d+)?)/);
          if (match) {
            this.config.worldSpeed = parseFloat(match[1].replace(',', '.'));
          }
        }

        // Se não encontrar na página, faz fetch do TWStats
        await this.fetchFromTWStats('settings');

        this.cache.settings.set(this.config);
        Utils.log('Configurações do mundo carregadas', this.config, 'debug');
      } catch (e) {
        Utils.log('Erro ao carregar configurações do mundo', e, 'error');
      }

      return this.config;
    },

    async loadUnitConfig() {
      const cached = this.cache.units.get();
      if (cached) {
        this.config.units = cached;
        return this.config.units;
      }

      try {
        Utils.log('Carregando configuração de unidades...', null, 'debug');
        await this.fetchFromTWStats('units');
        this.cache.units.set(this.config.units);
        Utils.log('Configuração de unidades carregada', null, 'debug');
      } catch (e) {
        Utils.log('Erro ao carregar configuração de unidades', e, 'error');
      }

      return this.config.units;
    },

    async loadBuildingConfig() {
      const cached = this.cache.buildings.get();
      if (cached) {
        this.config.buildings = cached;
        return this.config.buildings;
      }

      try {
        Utils.log('Carregando configuração de edifícios...', null, 'debug');
        await this.fetchFromTWStats('buildings');
        this.cache.buildings.set(this.config.buildings);
        Utils.log('Configuração de edifícios carregada', null, 'debug');
      } catch (e) {
        Utils.log('Erro ao carregar configuração de edifícios', e, 'error');
      }

      return this.config.buildings;
    },

    async fetchFromTWStats(page) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `https://br.twstats.com/br136/index.php?page=${page}`,
          onload: (response) => {
            try {
              const parser = new DOMParser();
              const doc = parser.parseFromString(response.responseText, 'text/html');
              
              if (page === 'settings') {
                this.parseSettingsPage(doc);
              } else if (page === 'units') {
                this.parseUnitsPage(doc);
              } else if (page === 'buildings') {
                this.parseBuildingsPage(doc);
              }
              
              resolve(this.config);
            } catch (e) {
              reject(e);
            }
          },
          onerror: (e) => {
            reject(e);
          }
        });
      });
    },

    parseSettingsPage(doc) {
      // Extrai configurações da página de settings
      const tables = Utils.safeQuerySelectorAll('table', doc);
      
      tables.forEach(table => {
        const rows = Utils.safeQuerySelectorAll('tr', table);
        rows.forEach(row => {
          const cells = Utils.safeQuerySelectorAll('td', row);
          if (cells.length >= 2) {
            const label = cells[0].textContent.toLowerCase();
            const value = cells[1].textContent.trim();
            
            if (label.includes('velocidade do mundo')) {
              this.config.worldSpeed = parseFloat(value.replace(',', '.')) || 1;
            } else if (label.includes('velocidade das tropas')) {
              this.config.unitSpeed = parseFloat(value.replace(',', '.')) || 1;
            } else if (label.includes('moral')) {
              this.config.moralEnabled = value.toLowerCase().includes('sim') || value === '1';
            } else if (label.includes('bônus noturno')) {
              this.config.nightBonusEnabled = value.toLowerCase().includes('sim') || value === '1';
            }
          }
        });
      });
    },

    parseUnitsPage(doc) {
      // Extrai dados de unidades
      const tables = Utils.safeQuerySelectorAll('table', doc);
      
      tables.forEach(table => {
        const headers = Utils.safeQuerySelectorAll('th', table);
        const hasUnitData = Array.from(headers).some(h => 
          h.textContent.toLowerCase().includes('madeira') ||
          h.textContent.toLowerCase().includes('argila')
        );
        
        if (hasUnitData) {
          const rows = Utils.safeQuerySelectorAll('tr', table);
          
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const cells = Utils.safeQuerySelectorAll('td', row);
            
            if (cells.length >= 8) {
              const name = Utils.safeQuerySelector('img', cells[0])?.getAttribute('title') || 
                          cells[0].textContent.trim();
              
              this.config.units[name.toLowerCase()] = {
                wood: Utils.parseBrazilianNumber(cells[1]?.textContent),
                clay: Utils.parseBrazilianNumber(cells[2]?.textContent),
                iron: Utils.parseBrazilianNumber(cells[3]?.textContent),
                time: Utils.parseTimeToSeconds(cells[4]?.textContent),
                speed: parseFloat(cells[5]?.textContent) || 0,
                capacity: Utils.parseBrazilianNumber(cells[6]?.textContent),
                attack: Utils.parseBrazilianNumber(cells[7]?.textContent)
              };
            }
          }
        }
      });
    },

    parseBuildingsPage(doc) {
      // Extrai dados de edifícios
      const tables = Utils.safeQuerySelectorAll('table', doc);
      
      tables.forEach(table => {
        const headers = Utils.safeQuerySelectorAll('th', table);
        const hasBuildingData = Array.from(headers).some(h => 
          h.textContent.toLowerCase().includes('custo') ||
          h.textContent.toLowerCase().includes('nível')
        );
        
        if (hasBuildingData) {
          const rows = Utils.safeQuerySelectorAll('tr', table);
          
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const cells = Utils.safeQuerySelectorAll('td', row);
            
            if (cells.length >= 5) {
              const name = cells[0]?.textContent.trim().toLowerCase();
              
              if (name) {
                this.config.buildings[name] = {
                  wood: Utils.parseBrazilianNumber(cells[1]?.textContent),
                  clay: Utils.parseBrazilianNumber(cells[2]?.textContent),
                  iron: Utils.parseBrazilianNumber(cells[3]?.textContent),
                  time: Utils.parseTimeToSeconds(cells[4]?.textContent)
                };
              }
            }
          }
        }
      });
    },

    getConfig() {
      return { ...this.config };
    },

    invalidateCache() {
      Object.values(this.cache).forEach(cache => cache.invalidate());
      Utils.log('Cache de configuração invalidado', null, 'debug');
    }
  };

  // ============================================================================
  // ARMAZENAMENTO PERSISTENTE
  // ============================================================================
  const GameStorage = {
    saveState(state) {
      try {
        const timestamp = Date.now();
        const key = `${CONFIG.STORAGE_PREFIX}state_${timestamp}`;
        
        GM_setValue(key, state);
        
        // Atualiza índice de estados
        const indices = GM_getValue(`${CONFIG.STORAGE_PREFIX}indices`, []);
        indices.push({ key, timestamp });
        
        // Mantém apenas os últimos N estados
        if (indices.length > CONFIG.MAX_HISTORY_ENTRIES) {
          const oldEntry = indices.shift();
          GM_deleteValue(oldEntry.key);
        }
        
        GM_setValue(`${CONFIG.STORAGE_PREFIX}indices`, indices);
        GM_setValue(`${CONFIG.STORAGE_PREFIX}last_state`, state);
        
        Utils.log('Estado salvo', { timestamp }, 'debug');
      } catch (e) {
        Utils.log('Erro ao salvar estado', e, 'error');
      }
    },

    loadState(timestamp = null) {
      try {
        if (timestamp) {
          const key = `${CONFIG.STORAGE_PREFIX}state_${timestamp}`;
          return GM_getValue(key, null);
        }
        
        return GM_getValue(`${CONFIG.STORAGE_PREFIX}last_state`, null);
      } catch (e) {
        Utils.log('Erro ao carregar estado', e, 'error');
        return null;
      }
    },

    getHistory(type = 'all', limit = 100) {
      try {
        const indices = GM_getValue(`${CONFIG.STORAGE_PREFIX}indices`, []);
        const history = [];
        
        const recentIndices = indices.slice(-limit);
        
        for (const entry of recentIndices) {
          const state = GM_getValue(entry.key, null);
          if (state) {
            if (type === 'all') {
              history.push(state);
            } else if (type === 'resources' && state.resources) {
              history.push({
                timestamp: state.timestamp,
                data: state.resources
              });
            } else if (type === 'buildings' && state.buildings) {
              history.push({
                timestamp: state.timestamp,
                data: state.buildings
              });
            }
          }
        }
        
        return history;
      } catch (e) {
        Utils.log('Erro ao obter histórico', e, 'error');
        return [];
      }
    },

    clearHistory() {
      try {
        const indices = GM_getValue(`${CONFIG.STORAGE_PREFIX}indices`, []);
        
        indices.forEach(entry => {
          GM_deleteValue(entry.key);
        });
        
        GM_setValue(`${CONFIG.STORAGE_PREFIX}indices`, []);
        GM_deleteValue(`${CONFIG.STORAGE_PREFIX}last_state`);
        
        Utils.log('Histórico limpo', null, 'debug');
      } catch (e) {
        Utils.log('Erro ao limpar histórico', e, 'error');
      }
    },

    getStateCount() {
      const indices = GM_getValue(`${CONFIG.STORAGE_PREFIX}indices`, []);
      return indices.length;
    }
  };

  // ============================================================================
  // OBSERVER DE MUDANÇAS NO JOGO
  // ============================================================================
  const GameObserver = {
    observers: [],
    callbacks: {
      resource: [],
      building: [],
      queue: []
    },
    running: false,
    lastState: {
      resources: null,
      buildings: null,
      queue: null
    },

    onResourceChange(callback) {
      this.callbacks.resource.push(callback);
      Utils.log('Callback de recurso registrado', null, 'debug');
    },

    onBuildingComplete(callback) {
      this.callbacks.building.push(callback);
      Utils.log('Callback de edifício registrado', null, 'debug');
    },

    onQueueChange(callback) {
      this.callbacks.queue.push(callback);
      Utils.log('Callback de fila registrado', null, 'debug');
    },

    start() {
      if (this.running) {
        Utils.log('Observer já está rodando', null, 'warn');
        return;
      }

      this.running = true;
      Utils.log('Iniciando observers...', null, 'info');

      // Inicializa estado anterior
      this.lastState = {
        resources: ResourceCollector.getAllResourceData(),
        buildings: BuildingCollector.getBuildingLevels(),
        queue: BuildingCollector.getBuildingQueue()
      };

      // Configura MutationObserver
      this.setupMutationObserver();

      // Loop de verificação periódica
      this.startPolling();
    },

    stop() {
      this.running = false;
      
      // Remove todos os observers
      this.observers.forEach(observer => {
        observer.disconnect();
      });
      this.observers = [];

      Utils.log('Observers parados', null, 'info');
    },

    setupMutationObserver() {
      const callback = Utils.debounce((mutations) => {
        if (!this.running) return;

        let resourcesChanged = false;
        let buildingsChanged = false;
        let queueChanged = false;

        mutations.forEach(mutation => {
          if (mutation.type === 'childList' || mutation.type === 'characterData') {
            // Verifica se mudou em áreas relevantes
            const target = mutation.target;
            
            // Verifica recursos
            if (target.closest('#header_info') || 
                target.id === 'wood' || 
                target.id === 'stone' || 
                target.id === 'iron' ||
                target.id === 'storage') {
              resourcesChanged = true;
            }

            // Verifica edifícios
            if (target.closest('#buildings') || 
                target.closest('#buildings_unmet') ||
                target.closest('#buildqueue')) {
              buildingsChanged = true;
              queueChanged = true;
            }
          }
        });

        if (resourcesChanged) {
          this.checkResourceChanges();
        }

        if (buildingsChanged || queueChanged) {
          this.checkBuildingChanges();
        }
      }, CONFIG.OBSERVER_DEBOUNCE);

      const observer = new MutationObserver(callback);
      
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      this.observers.push(observer);
      Utils.log('MutationObserver configurado', null, 'debug');
    },

    startPolling() {
      const pollInterval = setInterval(() => {
        if (!this.running) {
          clearInterval(pollInterval);
          return;
        }

        this.checkResourceChanges();
        this.checkBuildingChanges();
      }, 5000); // Verifica a cada 5 segundos

      this.observers.push({ disconnect: () => clearInterval(pollInterval) });
    },

    checkResourceChanges() {
      const currentState = ResourceCollector.getAllResourceData();
      
      if (this.lastState.resources) {
        const changed = 
          currentState.wood !== this.lastState.resources.wood ||
          currentState.clay !== this.lastState.resources.clay ||
          currentState.iron !== this.lastState.resources.iron ||
          currentState.storage !== this.lastState.resources.storage;

        if (changed) {
          Utils.log('Mudança de recursos detectada', currentState, 'debug');
          
          this.callbacks.resource.forEach(callback => {
            try {
              callback(currentState);
            } catch (e) {
              Utils.log('Erro no callback de recurso', e, 'error');
            }
          });
        }
      }

      this.lastState.resources = currentState;
    },

    checkBuildingChanges() {
      const currentBuildings = BuildingCollector.getBuildingLevels();
      const currentQueue = BuildingCollector.getBuildingQueue();

      // Verifica se algum edifício completou
      if (this.lastState.buildings) {
        Object.keys(currentBuildings).forEach(type => {
          if (currentBuildings[type] > (this.lastState.buildings[type] || 0)) {
            Utils.log('Edifício completado!', { type, newLevel: currentBuildings[type] }, 'info');
            
            this.callbacks.building.forEach(callback => {
              try {
                callback({ building: type, newLevel: currentBuildings[type] });
              } catch (e) {
                Utils.log('Erro no callback de edifício', e, 'error');
              }
            });
          }
        });
      }

      // Verifica mudanças na fila
      if (this.lastState.queue) {
        const queueChanged = 
          currentQueue.length !== this.lastState.queue.length ||
          currentQueue.some((item, i) => 
            item.timeRemaining !== (this.lastState.queue[i]?.timeRemaining || 0)
          );

        if (queueChanged) {
          Utils.log('Mudança na fila de construção', currentQueue, 'debug');
          
          this.callbacks.queue.forEach(callback => {
            try {
              callback({
                buildingQueue: currentQueue,
                recruitQueue: [] // TODO: implementar fila de recrutamento
              });
            } catch (e) {
              Utils.log('Erro no callback de fila', e, 'error');
            }
          });
        }
      }

      this.lastState.buildings = currentBuildings;
      this.lastState.queue = currentQueue;
    }
  };

  // ============================================================================
  // BOT PRINCIPAL
  // ============================================================================
  const TribalWarsBot = {
    initialized: false,
    tickInterval: null,

    async init() {
      if (this.initialized) {
        Utils.log('Bot já inicializado', null, 'warn');
        return;
      }

      Utils.log('=== Inicializando Tribal Wars Bot ===', null, 'info');

      try {
        // 1. Carrega configurações do mundo
        Utils.log('Carregando configurações...', null, 'debug');
        await WorldConfig.loadWorldSettings();
        await Promise.all([
          WorldConfig.loadUnitConfig(),
          WorldConfig.loadBuildingConfig()
        ]);

        // 2. Coleta estado inicial
        Utils.log('Coletando estado inicial...', null, 'debug');
        const initialState = this.getFullState();
        Utils.log('Estado inicial coletado', initialState, 'debug');

        // 3. Salva estado inicial
        GameStorage.saveState(initialState);

        // 4. Configura observers
        Utils.log('Configurando observers...', null, 'debug');
        GameObserver.start();

        // 5. Inicia loop principal
        this.startTickLoop();

        // 6. Exibe painel de status (opcional)
        this.showStatusPanel(initialState);

        this.initialized = true;
        Utils.log('=== Bot inicializado com sucesso! ===', null, 'info');
      } catch (e) {
        Utils.log('Erro crítico na inicialização', e, 'error');
      }
    },

    getFullState() {
      return {
        timestamp: Date.now(),
        resources: ResourceCollector.getCurrentResources(),
        production: ResourceCollector.getProductionRates(),
        storage: ResourceCollector.getStorageCapacity(),
        population: ResourceCollector.getPopulation(),
        buildings: BuildingCollector.getBuildingLevels(),
        buildingQueue: BuildingCollector.getBuildingQueue(),
        worldConfig: WorldConfig.getConfig()
      };
    },

    startTickLoop() {
      if (this.tickInterval) {
        clearInterval(this.tickInterval);
      }

      this.tickInterval = setInterval(async () => {
        await this.tick();
      }, CONFIG.TICK_INTERVAL);

      Utils.log(`Loop principal iniciado (intervalo: ${CONFIG.TICK_INTERVAL}ms)`, null, 'debug');
    },

    async tick() {
      try {
        const state = this.getFullState();
        GameStorage.saveState(state);
        
        Utils.log('Tick completado', { timestamp: state.timestamp }, 'debug');
        
        // Futuro: passar state para o motor de decisão
        // DecisionEngine.process(state);
        
        return state;
      } catch (e) {
        Utils.log('Erro no tick', e, 'error');
        return null;
      }
    },

    showStatusPanel(state) {
      if (!CONFIG.DEBUG) return;

      // Cria overlay de debug
      const panel = document.createElement('div');
      panel.id = 'twbot-status-panel';
      panel.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        width: 300px;
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        padding: 15px;
        border-radius: 8px;
        font-family: Arial, sans-serif;
        font-size: 12px;
        z-index: 999999;
        border: 2px solid #4CAF50;
        max-height: 80vh;
        overflow-y: auto;
      `;

      const updatePanel = () => {
        const currentState = this.getFullState();
        
        panel.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <strong style="color: #4CAF50;">🤖 TWBot Status</strong>
            <button onclick="document.getElementById('twbot-status-panel').remove()" style="background: none; border: none; color: #fff; cursor: pointer;">✕</button>
          </div>
          
          <div style="margin-bottom: 10px;">
            <strong>Recursos:</strong><br>
            🪵 Madeira: ${currentState.resources.wood.toLocaleString('pt-BR')} (+${currentState.production.wood}/h)<br>
            🧱 Argila: ${currentState.resources.clay.toLocaleString('pt-BR')} (+${currentState.production.clay}/h)<br>
            🔩 Ferro: ${currentState.resources.iron.toLocaleString('pt-BR')} (+${currentState.production.iron}/h)<br>
            📦 Armazém: ${currentState.storage.toLocaleString('pt-BR')}
          </div>
          
          <div style="margin-bottom: 10px;">
            <strong>População:</strong><br>
            👥 ${currentState.population.current}/${currentState.population.max}
          </div>
          
          <div style="margin-bottom: 10px;">
            <strong>Construção:</strong><br>
            ${currentState.buildingQueue.length > 0 
              ? currentState.buildingQueue.map(q => 
                  `🏗️ ${q.building} (nível ${q.level}) - ${this.formatTime(q.timeRemaining)}`
                ).join('<br>')
              : '🆗 Fila vazia'}
          </div>
          
          <div style="margin-bottom: 10px;">
            <strong>Sistema:</strong><br>
            ⏱️ Tick: ${CONFIG.TICK_INTERVAL / 1000}s<br>
            💾 Estados salvos: ${GameStorage.getStateCount()}<br>
            🐛 Debug: ${CONFIG.DEBUG ? 'ON' : 'OFF'}
          </div>
          
          <div style="border-top: 1px solid #555; padding-top: 10px;">
            <button onclick="TWBot.Utils.exportLogs()" style="width: 100%; padding: 5px; margin-bottom: 5px; cursor: pointer;">📥 Exportar Logs</button>
            <button onclick="TWBot.GameObserver.stop(); alert('Observers parados')" style="width: 100%; padding: 5px; cursor: pointer;">⏹️ Parar Observer</button>
          </div>
        `;
      };

      updatePanel();
      document.body.appendChild(panel);

      // Atualiza painel a cada 5 segundos
      const panelInterval = setInterval(() => {
        if (!document.getElementById('twbot-status-panel')) {
          clearInterval(panelInterval);
          return;
        }
        updatePanel();
      }, 5000);
    },

    formatTime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    },

    // Expõe módulos globalmente
    Resources: ResourceCollector,
    Buildings: BuildingCollector,
    ConstructionQueue: ConstructionQueueCollector,
    WorldConfig: WorldConfig,
    Storage: GameStorage,
    Observer: GameObserver,
    Utils: Utils
  };

  // ============================================================================
  // EXPORTAÇÃO GLOBAL
  // ============================================================================
  window.TWBot = TribalWarsBot;

  // Auto-inicialização quando a página carregar completamente
  if (document.readyState === 'complete') {
    TribalWarsBot.init();
  } else {
    window.addEventListener('load', () => {
      TribalWarsBot.init();
    });
  }

  // Comandos de console úteis
  console.log('%c🤖 TWBot Carregado!', 'color: #4CAF50; font-size: 16px; font-weight: bold;');
  console.log('%cUse TWBot.init() para inicializar manualmente', 'color: #2196F3;');
  console.log('%cComandos úteis:', 'color: #FF9800;');
  console.log('  TWBot.Resources.getCurrentResources()');
  console.log('  TWBot.Buildings.getAllBuildings()');
  console.log('  TWBot.Storage.getHistory("resources")');
  console.log('  TWBot.Utils.exportLogs()');

})();
