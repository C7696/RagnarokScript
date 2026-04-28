# 🤖 Tribal Wars Bot - Data Collector (BR136)

## 📋 Visão Geral

UserScript profissional para automação de Tribal Wars (Servidor Brasileiro - Mundo 136). Este módulo implementa a **Fase 1: Coleta de Dados**, extraindo informações do DOM do jogo de forma confiável e performática.

---

## 🚀 Instalação no Tampermonkey

### Passo 1: Instale o Tampermonkey

1. **Chrome/Edge**: [Baixe da Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
2. **Firefox**: [Baixe do Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
3. **Safari**: [Baixe da App Store](https://apps.apple.com/app/tampermonkey/id1482490089)

### Passo 2: Instale o Script

1. Clique no ícone do Tampermonkey na barra de extensões
2. Selecione **"Criar novo script"**
3. Apague todo o conteúdo padrão
4. Copie e cole o conteúdo completo do arquivo `tw-data-collector.user.js`
5. Pressione **Ctrl+S** (ou **Cmd+S** no Mac) para salvar
6. Ative o script se estiver desativado (chave verde)

### Passo 3: Acesse o Jogo

1. Vá para https://br136.tribalwars.com.br/
2. Faça login na sua conta
3. O bot será inicializado automaticamente quando a página carregar

---

## 📦 Módulos Disponíveis

### 1. ResourceCollector - Coleta de Recursos

```javascript
// Obter recursos atuais
TWBot.Resources.getCurrentResources();
// Retorna: { wood: 1234, clay: 5678, iron: 9012, storage: 10000 }

// Obter taxas de produção por hora
TWBot.Resources.getProductionRates();
// Retorna: { wood: 500, clay: 600, iron: 400 }

// Obter capacidade do armazém
TWBot.Resources.getStorageCapacity();
// Retorna: 10000

// Obter população
TWBot.Resources.getPopulation();
// Retorna: { current: 250, max: 300 }

// Obter todos os dados de recursos de uma vez
TWBot.Resources.getAllResourceData();
```

### 2. BuildingCollector - Coleta de Edifícios

```javascript
// Obter nível de um edifício específico
TWBot.Buildings.getBuildingLevel('barracks');
// Retorna: { level: 5, built: true }

// Obter níveis de todos os edifícios
TWBot.Buildings.getBuildingLevels();
// Retorna: { main: 15, barracks: 5, stable: 0, ... }

// Obter edifícios disponíveis
TWBot.Buildings.getAvailableBuildings();
// Retorna: [{ type: 'main', level: 15, built: true }, ...]

// Obter edifícios indisponíveis (bloqueados)
TWBot.Buildings.getUnavailableBuildings();
// Retorna: [{ name: 'Academia', requirements: 'Edifício principal nível 15' }, ...]

// Obter fila de construção
TWBot.Buildings.getBuildingQueue();
// Retorna: [{ building: 'main', level: 16, timeRemaining: 3600 }, ...]

// Obter todos os dados de edifícios
TWBot.Buildings.getAllBuildings();
```

### 3. ConstructionQueueCollector - Fila de Construção

```javascript
// Obter fila completa
TWBot.ConstructionQueue.getQueue();

// Obter tempo total restante na fila (em segundos)
TWBot.ConstructionQueue.getTotalQueueTime();

// Verificar se fila está vazia
TWBot.ConstructionQueue.isQueueEmpty();

// Obter próxima construção
TWBot.ConstructionQueue.getNextBuilding();
```

### 4. WorldConfig - Configuração do Mundo

```javascript
// Carregar configurações do mundo (assíncrono)
await TWBot.WorldConfig.loadWorldSettings();

// Carregar configuração de unidades (assíncrono)
await TWBot.WorldConfig.loadUnitConfig();

// Carregar configuração de edifícios (assíncrono)
await TWBot.WorldConfig.loadBuildingConfig();

// Obter configuração completa
TWBot.WorldConfig.getConfig();
// Retorna: { worldSpeed: 1, unitSpeed: 1, moralEnabled: true, ... }
```

### 5. GameStorage - Armazenamento Persistente

```javascript
// Salvar estado atual
const state = TWBot.getFullState();
TWBot.Storage.saveState(state);

// Carregar último estado salvo
TWBot.Storage.loadState();

// Carregar estado de timestamp específico
TWBot.Storage.loadState(1234567890000);

// Obter histórico de recursos
TWBot.Storage.getHistory('resources', 50);

// Obter histórico de edifícios
TWBot.Storage.getHistory('buildings', 50);

// Limpar histórico
TWBot.Storage.clearHistory();
```

### 6. GameObserver - Observer de Mudanças

```javascript
// Registrar callback para mudança de recursos
TWBot.Observer.onResourceChange((data) => {
  console.log('Recursos mudaram:', data);
});

// Registrar callback para edifício completado
TWBot.Observer.onBuildingComplete((data) => {
  console.log('Edifício completado:', data.building, 'nível', data.newLevel);
});

// Registrar callback para mudança na fila
TWBot.Observer.onQueueChange((data) => {
  console.log('Fila mudou:', data.buildingQueue);
});

// Iniciar observers
TWBot.Observer.start();

// Parar observers
TWBot.Observer.stop();
```

### 7. TribalWarsBot - Bot Principal

```javascript
// Inicializar bot manualmente (se necessário)
await TWBot.init();

// Obter estado completo do jogo
const fullState = TWBot.getFullState();
/* Retorna:
{
  timestamp: 1234567890000,
  resources: { wood, clay, iron, storage },
  production: { wood, clay, iron },
  population: { current, max },
  buildings: { main, barracks, stable, ... },
  buildingQueue: [...],
  worldConfig: { ... }
}
*/

// Executar tick manual
await TWBot.tick();
```

---

## 🔧 Configuração

### Ativar Modo Debug

No console do navegador, execute:
```javascript
GM_setValue('twbot_debug', true);
location.reload();
```

O modo debug exibe:
- ✅ Painel de status no canto superior direito
- ✅ Logs detalhados no console
- ✅ Botões para exportar logs e controlar observers

### Desativar Modo Debug

```javascript
GM_setValue('twbot_debug', false);
location.reload();
```

---

## 🛠️ Comandos Úteis no Console

```javascript
// Exportar logs para arquivo JSON
TWBot.Utils.exportLogs();

// Invalidar caches
TWBot.Resources.invalidateCache();
TWBot.Buildings.invalidateCache();
TWBot.WorldConfig.invalidateCache();

// Ver número de estados salvos
TWBot.Storage.getStateCount();

// Parar observers manualmente
TWBot.Observer.stop();

// Reiniciar bot
location.reload();
```

---

## 📊 Estrutura do Código

```
tw-data-collector.user.js
├── CONFIG                  // Configurações globais
├── Utils                   // Utilitários (parse, cache, debounce, etc.)
├── ResourceCollector       // Coleta de recursos
├── BuildingCollector       // Coleta de edifícios
├── ConstructionQueueCollector  // Coleta de fila de construção
├── WorldConfig            // Configuração do mundo (TWStats)
├── GameStorage            // Armazenamento persistente
├── GameObserver           // MutationObserver para mudanças
└── TribalWarsBot          // Bot principal (orquestrador)
```

---

## 🔒 Segurança e Robustez

### Características de Segurança

- ✅ **Não modifica o DOM visível** (indetectável visualmente)
- ✅ **Nomes de variáveis genéricos** (sem "cheat", "hack", "bot" em nomes expostos)
- ✅ **Escopo isolado** (IIFE - Immediately Invoked Function Expression)
- ✅ **Tratamento de erros silencioso** (não quebra o jogo)

### Recursos de Robustez

- ✅ **Múltiplos seletores fallback** (ID → classe → XPath)
- ✅ **Verificação de existência** antes de acessar elementos
- ✅ **Cache com TTL** para performance
- ✅ **Debounce em callbacks** de alta frequência
- ✅ **Retry automático** em operações falhas

---

## 🐛 Debug e Troubleshooting

### O script não está funcionando?

1. **Verifique se o Tampermonkey está ativo**
   - Ícone deve estar colorido (não cinza)
   
2. **Verifique se o script está habilitado**
   - No dashboard do Tampermonkey, a chave deve estar verde

3. **Verifique o console do navegador**
   - Pressione F12 → Console
   - Procure por mensagens começando com `[TWBot]`

4. **Ative o modo debug**
   ```javascript
   GM_setValue('twbot_debug', true);
   location.reload();
   ```

5. **Exporte os logs para análise**
   ```javascript
   TWBot.Utils.exportLogs();
   ```

### Erros comuns

| Erro | Causa | Solução |
|------|-------|---------|
| `TWBot is not defined` | Script não carregou | Recarregue a página (F5) |
| Recursos retornam 0 | Página errada | Esteja na visão geral da vila |
| Observers não funcionam | Já estão rodando | Verifique console, use `stop()` antes |

---

## 📈 Próximas Fases

Este é o módulo de **Coleta de Dados**. Próximas fases planejadas:

1. ✅ **Fase 1: Coleta de Dados** (COMPLETO)
2. ⏳ Fase 2: Unidades e Tropas
3. ⏳ Fase 3: Mapa e Coordenadas
4. ⏳ Fase 4: Relatórios e Batalhas
5. ⏳ Fase 5: Motor de Decisão (IA)
6. ⏳ Fase 6: Interface Dashboard

---

## 📝 Changelog

### v1.0.0
- ✅ Implementação inicial completa
- ✅ Coleta de recursos com múltiplos fallbacks
- ✅ Coleta de edifícios e fila de construção
- ✅ Configuração do mundo via TWStats
- ✅ Armazenamento persistente com histórico
- ✅ MutationObserver para detecção de mudanças
- ✅ Painel de debug overlay
- ✅ Exportação de logs
- ✅ Cache inteligente com TTL

---

## 🎯 API Reference Rápida

```javascript
// === RECURSOS ===
TWBot.Resources.getCurrentResources()      // { wood, clay, iron, storage }
TWBot.Resources.getProductionRates()       // { wood, clay, iron } /hora
TWBot.Resources.getStorageCapacity()       // número
TWBot.Resources.getPopulation()            // { current, max }
TWBot.Resources.getAllResourceData()       // objeto completo

// === EDIFÍCIOS ===
TWBot.Buildings.getBuildingLevel(type)     // { level, built }
TWBot.Buildings.getBuildingLevels()        // { main: X, barracks: Y, ... }
TWBot.Buildings.getAvailableBuildings()    // array de edifícios
TWBot.Buildings.getUnavailableBuildings()  // array de bloqueados
TWBot.Buildings.getBuildingQueue()         // array da fila
TWBot.Buildings.getAllBuildings()          // objeto completo

// === FILA ===
TWBot.ConstructionQueue.getQueue()         // array
TWBot.ConstructionQueue.getTotalQueueTime() // segundos
TWBot.ConstructionQueue.isQueueEmpty()     // boolean
TWBot.ConstructionQueue.getNextBuilding()  // próximo item ou null

// === MUNDO ===
await TWBot.WorldConfig.loadWorldSettings()
await TWBot.WorldConfig.loadUnitConfig()
await TWBot.WorldConfig.loadBuildingConfig()
TWBot.WorldConfig.getConfig()

// === ARMAZENAMENTO ===
TWBot.Storage.saveState(state)
TWBot.Storage.loadState(timestamp?)
TWBot.Storage.getHistory(type, limit)
TWBot.Storage.clearHistory()

// === OBSERVER ===
TWBot.Observer.onResourceChange(callback)
TWBot.Observer.onBuildingComplete(callback)
TWBot.Observer.onQueueChange(callback)
TWBot.Observer.start()
TWBot.Observer.stop()

// === BOT ===
await TWBot.init()
TWBot.getFullState()
await TWBot.tick()

// === UTILITÁRIOS ===
TWBot.Utils.exportLogs()
TWBot.Utils.log(message, data, level)
```

---

## 💡 Dicas de Uso

1. **Sempre aguarde o carregamento completo da página** antes de chamar funções
2. **Use o modo debug** durante desenvolvimento para ver o que está acontecendo
3. **Exporte logs regularmente** para backup e análise
4. **Não chame métodos de coleta em loop rápido** - use o observer ou o tick do bot
5. **O cache é automático** - não precisa se preocupar em otimizar chamadas

---

## 📞 Suporte

Para reportar bugs ou sugerir melhorias, analise os logs exportados e verifique:
- Versão do Tampermonkey
- Navegador utilizado
- URL exata onde ocorreu o erro
- Mensagens de erro no console

---

**Desenvolvido com ❤️ para a comunidade Tribal Wars BR**
