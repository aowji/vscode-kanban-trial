(function () {
  'use strict';

  const UNASSIGNED_LIST_ID = '__unassigned';

  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : createPreviewApi();

  /** @type {{ view: any, context: any } | null} */
  let model = null;
  let busy = false;
  let query = '';
  const tagFilter = new Set();
  let dragCardId = null;
  let dragListId = null;
  let menu = null;
  let addingList = false;
  let addListDraft = '';
  /** Lists narrowed to a strip; a view preference, so it lives in webview state. */
  const collapsedLists = new Set();

  const app = document.getElementById('app');

  function createPreviewApi() {
    return {
      postMessage(message) {
        console.log('[preview] postMessage', message);
      },
      getState() {
        return undefined;
      },
      setState() {},
    };
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );
  }

  function relativeTime(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return 'just now';
    if (diff < hour) return Math.floor(diff / minute) + 'm ago';
    if (diff < day) return Math.floor(diff / hour) + 'h ago';
    if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function allCards() {
    if (!model) return [];
    return model.view.lists.reduce((cards, list) => cards.concat(list.cards), []);
  }

  function findCard(cardId) {
    return allCards().find((card) => card.absPath === cardId) || null;
  }

  /** Lists that live in the board file; the "No status" bucket is not one of them. */
  function boardLists() {
    return model ? model.view.lists.filter((list) => list.tag !== null) : [];
  }

  function cardMatchesFilters(card) {
    if (tagFilter.size > 0) {
      const tags = new Set(card.extraTags.map((tag) => tag.toLowerCase()));
      if (card.listTag) tags.add(card.listTag.toLowerCase());
      for (const tag of tagFilter) {
        if (!tags.has(tag)) return false;
      }
    }
    if (!query) return true;
    const haystack = [card.title, card.relPath, card.summary, card.extraTags.join(' ')]
      .join(' ')
      .toLowerCase();
    return haystack.indexOf(query.toLowerCase()) !== -1;
  }

  // ---------------------------------------------------------------- rendering

  function ensureShell() {
    if (app.dataset.shell === '1') return;
    app.dataset.shell = '1';
    app.innerHTML = [
      '<div class="toolbar">',
      '<div class="search"><input id="search" type="search" placeholder="Search titles, tags and paths" aria-label="Search cards" autocomplete="off" spellcheck="false" /></div>',
      '<div class="stats" id="stats"></div>',
      '<div class="actions">',
      '<button id="btn-refresh" class="icon-button" type="button" title="Reload the board" aria-label="Reload the board">&#x21bb;</button>',
      '<button id="btn-text" class="icon-button" type="button" title="Edit this file as YAML" aria-label="Edit this file as YAML">&#x270e;</button>',
      '</div>',
      '</div>',
      '<div class="tagbar" id="tagbar"></div>',
      '<div class="notice" id="notice" hidden></div>',
      '<div class="board" id="board"></div>',
      '<div class="placeholder" id="placeholder" hidden></div>',
    ].join('');

    const search = document.getElementById('search');
    search.value = query;
    search.addEventListener('input', () => {
      query = search.value.trim();
      persist();
      renderLists();
      renderStats();
    });

    app.addEventListener('click', onClick);
    app.addEventListener('keydown', onKeyDown);
    app.addEventListener('dragstart', onDragStart);
    app.addEventListener('dragend', onDragEnd);
    app.addEventListener('dragover', onDragOver);
    app.addEventListener('dragleave', onDragLeave);
    app.addEventListener('drop', onDrop);
  }

  function render() {
    ensureShell();
    renderStats();
    renderTagbar();
    renderNotice();
    renderLists();
    renderPlaceholder();
    setBusy(busy);
  }

  function renderStats() {
    const stats = document.getElementById('stats');
    if (!stats || !model) return;
    const total = model.view.totalCards;
    const shown = allCards().filter(cardMatchesFilters).length;
    const cards = shown === total
      ? total + ' card' + (total === 1 ? '' : 's')
      : shown + ' of ' + total + ' cards';
    const files = model.meta.fileCount + ' file' + (model.meta.fileCount === 1 ? '' : 's');
    stats.textContent = [cards, files, model.meta.boardFileName].join(' \u00b7 ');
    stats.title = model.meta.boardFile;
  }

  function renderTagbar() {
    const tagbar = document.getElementById('tagbar');
    if (!tagbar || !model) return;

    const counts = new Map();
    for (const card of allCards()) {
      const tags = card.listTag ? [card.listTag].concat(card.extraTags) : card.extraTags;
      for (const tag of tags) {
        const key = tag.toLowerCase();
        const entry = counts.get(key) || { label: tag, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }

    if (counts.size === 0 && tagFilter.size === 0) {
      tagbar.innerHTML = '';
      tagbar.hidden = true;
      return;
    }
    tagbar.hidden = false;

    const items = [...counts.entries()].sort(
      (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
    );
    const chips = items
      .map(([key, entry]) => {
        const active = tagFilter.has(key);
        return (
          '<button type="button" class="chip tag-filter' + (active ? ' chip-active' : '') +
          '" data-tag="' + esc(key) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
          esc(entry.label) + '<span class="chip-count">' + entry.count + '</span></button>'
        );
      })
      .join('');
    const clear = tagFilter.size > 0
      ? '<button type="button" class="link-button" id="clear-tags">Clear filters</button>'
      : '';
    tagbar.innerHTML = '<span class="tagbar-label">Tags</span>' + chips + clear;

    const clearButton = document.getElementById('clear-tags');
    if (clearButton) {
      clearButton.addEventListener('click', () => {
        tagFilter.clear();
        persist();
        render();
      });
    }
  }

  function renderNotice() {
    const notice = document.getElementById('notice');
    if (!notice || !model) return;
    const messages = [];
    if (model.meta.storeError) messages.push(model.meta.storeError);
    if (model.meta.truncated) {
      messages.push(
        'Only the first ' + model.meta.fileCount +
        ' Markdown files were scanned. Raise markdownKanban.maxFiles to see more.',
      );
    }
    if (model.meta.staleEntries > 0) {
      messages.push(
        model.meta.staleEntries +
        ' saved card(s) point at documents that no longer exist; they are ignored until the document comes back.',
      );
    }
    notice.hidden = messages.length === 0;
    notice.textContent = messages.join(' ');
  }

  function cardHtml(card) {
    const chips = card.extraTags
      .map((tag) => '<button type="button" class="chip" data-tag="' + esc(tag.toLowerCase()) + '">' + esc(tag) + '</button>')
      .join('');
    return [
      '<article class="card' + (card.error ? ' card-error' : '') + '" draggable="true" data-card="' + esc(card.absPath) +
        '" tabindex="0">',
      '<div class="card-title">' + esc(card.title) + '</div>',
      card.summary ? '<p class="card-summary">' + esc(card.summary) + '</p>' : '',
      chips ? '<div class="card-tags">' + chips + '</div>' : '',
      '<div class="card-foot">',
      '<span class="card-path" title="' + esc(card.relPath) + '">' + esc(card.relPath) + '</span>',
      '<span class="card-time">' + esc(relativeTime(card.updated)) + '</span>',
      '<button type="button" class="card-menu" data-menu="' + esc(card.absPath) + '" aria-haspopup="menu" aria-label="Card actions" title="Card actions">&#x22ee;</button>',
      '</div>',
      card.error ? '<div class="card-warn">&#x26a0; ' + esc(card.error) + '</div>' : '',
      '</article>',
    ].join('');
  }

  function listHtml(list) {
    const collapsed = collapsedLists.has(list.id);
    const cards = list.cards.filter(cardMatchesFilters);
    const count = cards.length === list.cards.length
      ? String(list.cards.length)
      : cards.length + '/' + list.cards.length;
    const body = cards.length
      ? cards.map(cardHtml).join('')
      : '<div class="list-empty">' +
        (list.tag === null
          ? (model.view.totalCards === 0
            ? 'No Markdown documents yet. Create a .md file in VS Code.'
            : 'Drag a card here to clear its status')
          : 'No cards') +
        '</div>';
    const isBoardList = list.tag !== null;
    const headAttrs = isBoardList ? ' draggable="true" data-drag-list="' + esc(list.id) + '"' : '';
    const actions = isBoardList
      ? '<button type="button" class="list-menu" data-menu-list="' + esc(list.id) + '" aria-haspopup="menu" title="List actions" aria-label="List actions ' + esc(list.title) + '">&#x22ee;</button>' +
        '<button type="button" class="list-remove" data-remove-list="' + esc(list.id) + '" title="Remove list" aria-label="Remove list ' + esc(list.title) + '">&times;</button>'
      : '';
    const toggleLabel = (collapsed ? 'Expand list ' : 'Collapse list ') + list.title;
    return [
      '<section class="list' + (collapsed ? ' collapsed' : '') + '" data-list="' + esc(list.id) + '">',
      '<header class="list-head"' + headAttrs + '>',
      '<button type="button" class="list-collapse" data-collapse-list="' + esc(list.id) +
        '" aria-expanded="' + (collapsed ? 'false' : 'true') + '" title="' + esc(toggleLabel) +
        '" aria-label="' + esc(toggleLabel) + '">' + (collapsed ? '&#x203a;' : '&#x2039;') + '</button>',
      '<span class="list-dot" aria-hidden="true"></span>',
      '<h2 class="list-title">' + esc(list.title) + '</h2>',
      '<span class="list-count">' + esc(count) + '</span>',
      actions,
      '</header>',
      '<div class="list-body" data-list="' + esc(list.id) + '">' + body + '</div>',
      '</section>',
    ].join('');
  }

  function addListFormHtml() {
    return [
      '<form class="list-add-form" data-add-form>',
      '<input type="text" class="add-list-input" placeholder="tag or tag:Title" aria-label="New list tag" autocomplete="off" spellcheck="false" value="' + esc(addListDraft) + '" />',
      '<div class="list-add-actions">',
      '<button type="submit" class="primary-button">Add</button>',
      '<button type="button" class="icon-button" data-cancel-add title="Cancel" aria-label="Cancel">&times;</button>',
      '</div>',
      '</form>',
    ].join('');
  }

  /** The single trailing slot that appends a list, and accepts a dropped list. */
  function addListSlotHtml() {
    return addingList
      ? '<div class="list-add-slot">' + addListFormHtml() + '</div>'
      : '<div class="list-add-slot"><button type="button" class="list-add-btn" data-add-open>+ Add list</button></div>';
  }

  function renderLists() {
    const board = document.getElementById('board');
    if (!board || !model) return;

    const scrollTops = new Map();
    board.querySelectorAll('.list-body').forEach((body) => scrollTops.set(body.dataset.list, body.scrollTop));
    const scrollLeft = board.scrollLeft;

    board.innerHTML = model.view.lists.map(listHtml).join('') + addListSlotHtml();
    board.scrollLeft = scrollLeft;
    board.querySelectorAll('.list-body').forEach((body) => {
      const top = scrollTops.get(body.dataset.list);
      if (top) body.scrollTop = top;
    });

    const form = board.querySelector('[data-add-form]');
    if (!form) return;
    const input = form.querySelector('.add-list-input');
    if (input) {
      input.addEventListener('input', () => {
        addListDraft = input.value;
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeAddList();
        }
      });
      input.focus();
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input ? input.value.trim() : '';
      if (!value) return;
      closeAddList();
      api.postMessage({ type: 'addList', entry: value });
    });
  }

  function openAddList() {
    addingList = true;
    addListDraft = '';
    renderLists();
  }

  function closeAddList() {
    if (!addingList) return;
    addingList = false;
    addListDraft = '';
    renderLists();
  }

  function renderPlaceholder() {
    const placeholder = document.getElementById('placeholder');
    if (!placeholder || !model) return;
    const hasLists = model.view.lists.length > 0;
    placeholder.hidden = hasLists;
    document.getElementById('board').hidden = !hasLists;
    if (hasLists) return;

    placeholder.innerHTML = [
      '<div class="placeholder-inner">',
      '<h2>No lists configured</h2>',
      '<p>Every <code>.md</code> file in <strong>' + esc(model.meta.folderName) +
        '</strong> becomes a card. Add a list with <code>+ Add list</code>, or edit the YAML.</p>',
      '</div>',
    ].join('');
  }

  function setBusy(value) {
    const button = document.getElementById('btn-refresh');
    if (!button) return;
    button.classList.toggle('spinning', value);
    button.disabled = value;
  }

  // ------------------------------------------------------------------ actions

  function onClick(event) {
    if (!(event.target instanceof Element)) return;

    if (event.target.closest('#btn-refresh')) {
      api.postMessage({ type: 'refresh' });
      return;
    }

    if (event.target.closest('#btn-text')) {
      api.postMessage({ type: 'openAsText' });
      return;
    }

    if (event.target.closest('[data-add-open]')) {
      event.stopPropagation();
      openAddList();
      return;
    }

    if (event.target.closest('[data-cancel-add]')) {
      closeAddList();
      return;
    }

    const listMenuButton = event.target.closest('[data-menu-list]');
    if (listMenuButton) {
      event.stopPropagation();
      openListMenu(listMenuButton, listMenuButton.dataset.menuList);
      return;
    }

    const removeButton = event.target.closest('[data-remove-list]');
    if (removeButton) {
      event.stopPropagation();
      api.postMessage({ type: 'removeList', listId: removeButton.dataset.removeList });
      return;
    }

    const collapseButton = event.target.closest('[data-collapse-list]');
    if (collapseButton) {
      event.stopPropagation();
      toggleCollapsed(collapseButton.dataset.collapseList);
      return;
    }

    // A collapsed list is a narrow strip: clicking anywhere on it expands it.
    const collapsedList = event.target.closest('.list.collapsed');
    if (collapsedList) {
      toggleCollapsed(collapsedList.dataset.list);
      return;
    }

    const cardMenuButton = event.target.closest('[data-menu]');
    if (cardMenuButton) {
      event.stopPropagation();
      openCardMenu(cardMenuButton, cardMenuButton.dataset.menu);
      return;
    }

    const chip = event.target.closest('[data-tag]');
    if (chip) {
      event.stopPropagation();
      toggleTag(chip.dataset.tag);
      return;
    }

    const card = event.target.closest('.card');
    if (card) api.postMessage({ type: 'openCard', path: card.dataset.card });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && menu) {
      closeMenu();
      return;
    }
    const card = event.target instanceof Element ? event.target.closest('.card') : null;
    if (!card) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      api.postMessage({ type: 'openCard', path: card.dataset.card });
      return;
    }
    if (event.key === 'm') {
      event.preventDefault();
      const button = card.querySelector('[data-menu]');
      if (button) openCardMenu(button, card.dataset.card);
    }
  }

  function toggleCollapsed(listId) {
    if (collapsedLists.has(listId)) collapsedLists.delete(listId);
    else collapsedLists.add(listId);
    persist();
    renderLists();
  }

  function toggleTag(tag) {
    const key = String(tag).toLowerCase();
    if (tagFilter.has(key)) tagFilter.delete(key);
    else tagFilter.add(key);
    persist();
    render();
  }

  // -------------------------------------------------------------- drag & drop

  function onDragStart(event) {
    if (!(event.target instanceof Element)) return;

    const head = event.target.closest('.list-head[draggable="true"]');
    if (head) {
      dragListId = head.dataset.dragList;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', 'list:' + dragListId);
      const list = head.closest('.list');
      if (list) list.classList.add('dragging-list');
      return;
    }

    const card = event.target.closest('.card');
    if (!card) return;
    dragCardId = card.dataset.card;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragCardId);
    card.classList.add('dragging');
  }

  function onDragEnd(event) {
    if (event.target instanceof Element) {
      const card = event.target.closest('.card');
      if (card) card.classList.remove('dragging');
    }
    clearListDropTargets();
    clearCardDropTargets();
    dragCardId = null;
    dragListId = null;
  }

  function onDragOver(event) {
    if (!(event.target instanceof Element)) return;

    if (dragListId) {
      // Anywhere on the board is a valid target, so the hint cannot go stale in
      // the gaps between lists or over the "No status" column.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      showListDropHint(listDropFromPointer(event.clientX));
      return;
    }

    const list = event.target.closest('.list');
    if (!list) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const zone = cardDropZone(list);
    clearCardDropTargets(zone);
    zone.classList.add('drop-target');
  }

  function onDragLeave(event) {
    if (!(event.target instanceof Element)) return;
    const board = document.getElementById('board');
    if (board && event.relatedTarget instanceof Node && board.contains(event.relatedTarget)) return;
    clearListDropTargets();
    clearCardDropTargets();
  }

  function onDrop(event) {
    if (!(event.target instanceof Element)) return;

    if (dragListId) {
      const movedId = dragListId;
      const index = listDropFromPointer(event.clientX);
      dragListId = null;
      event.preventDefault();
      clearListDropTargets();
      document.querySelectorAll('.list.dragging-list').forEach((el) => el.classList.remove('dragging-list'));
      moveListTo(movedId, index);
      return;
    }

    const list = event.target.closest('.list');
    if (!list) return;
    event.preventDefault();
    clearCardDropTargets();
    const cardId = dragCardId || event.dataTransfer.getData('text/plain');
    dragCardId = null;
    if (!cardId) return;
    const card = findCard(cardId);
    const listId = list.dataset.list;
    if (!card || card.listId === listId) return;
    optimisticMove(cardId, listId);
    api.postMessage({ type: 'moveCard', path: cardId, listId: listId });
  }

  /** Where a dropped card lands: the list body, or the strip of a collapsed list. */
  function cardDropZone(list) {
    if (list.classList.contains('collapsed')) return list;
    return list.querySelector('.list-body') || list;
  }

  /** Board lists in DOM order, minus the one being dragged. */
  function remainingLists() {
    return [...document.querySelectorAll('.list')].filter(
      (list) => list.dataset.list !== UNASSIGNED_LIST_ID && list.dataset.list !== dragListId,
    );
  }

  /**
   * Final index a dragged list would take, counting the other lists only, so the
   * value is already the position after the dragged list has been taken out.
   * The dragged list itself is never a target, which keeps dropping a list onto
   * its own column a no-op instead of sending it to the end.
   */
  function listDropFromPointer(clientX) {
    const lists = remainingLists();
    let index = 0;
    for (const list of lists) {
      const rect = list.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) index += 1;
    }
    return index;
  }

  /** Draws the insertion line exactly where the list would land. */
  function showListDropHint(index) {
    const lists = remainingLists();
    clearListDropTargets();
    if (lists.length === 0) return;
    if (index >= lists.length) {
      const slot = document.querySelector('.list-add-slot');
      if (slot) slot.classList.add('drop-target');
      return;
    }
    // The line sits between lists[index-1] and lists[index], drawn on whichever
    // of the two columns already exists at that boundary.
    if (index === 0) lists[0].classList.add('drop-before');
    else lists[index - 1].classList.add('drop-after');
  }

  /** Sends a list move only when the final position differs from the current one. */
  function moveListTo(listId, index) {
    if (boardLists().findIndex((list) => list.id === listId) === index) return;
    api.postMessage({ type: 'moveList', listId: listId, index: index });
  }

  function clearListDropTargets() {
    document
      .querySelectorAll('.list.drop-before, .list.drop-after, .list-add-slot.drop-target')
      .forEach((element) => element.classList.remove('drop-before', 'drop-after', 'drop-target'));
  }

  function clearCardDropTargets(except) {
    document.querySelectorAll('.list-body.drop-target, .list.drop-target').forEach((zone) => {
      if (zone !== except) zone.classList.remove('drop-target');
    });
  }

  function optimisticMove(cardId, listId) {
    const from = model.view.lists.find((list) => list.cards.some((card) => card.absPath === cardId));
    const to = model.view.lists.find((list) => list.id === listId);
    if (!from || !to) return;
    const index = from.cards.findIndex((card) => card.absPath === cardId);
    if (index === -1) return;
    const card = from.cards.splice(index, 1)[0];
    card.listId = listId;
    card.listTag = listId === UNASSIGNED_LIST_ID ? null : to.tag;
    to.cards.unshift(card);
    render();
  }

  // --------------------------------------------------------------------- menu

  function openCardMenu(anchor, cardId) {
    const card = findCard(cardId);
    if (!card || !model) return;

    const items = [];
    for (const target of model.meta.moveTargets) {
      if (target.id === card.listId) continue;
      items.push({
        label: 'Move to ' + target.title,
        run: () => {
          optimisticMove(cardId, target.id);
          api.postMessage({ type: 'moveCard', path: cardId, listId: target.id });
        },
      });
    }
    items.push({ separator: true });
    items.push({ label: 'Open', run: () => api.postMessage({ type: 'openCard', path: cardId }) });
    items.push({ label: 'Reveal in Explorer', run: () => api.postMessage({ type: 'revealCard', path: cardId }) });
    items.push({ label: 'Copy path', run: () => api.postMessage({ type: 'copyPath', path: cardId }) });
    showMenu(anchor, items);
  }

  function openListMenu(anchor, listId) {
    if (!model) return;
    const ids = boardLists().map((list) => list.id);
    const at = ids.indexOf(listId);
    if (at === -1) return;

    const items = [];
    if (at > 0) {
      items.push({ label: 'Move left', run: () => api.postMessage({ type: 'moveList', listId: listId, index: at - 1 }) });
    }
    if (at < ids.length - 1) {
      items.push({ label: 'Move right', run: () => api.postMessage({ type: 'moveList', listId: listId, index: at + 1 }) });
    }
    items.push({ label: 'Add list before', run: () => api.postMessage({ type: 'addList', index: at }) });
    items.push({ label: 'Add list after', run: () => api.postMessage({ type: 'addList', index: at + 1 }) });
    items.push({ separator: true });
    items.push({ label: 'Rename list', run: () => api.postMessage({ type: 'renameList', listId: listId }) });
    items.push({
      label: collapsedLists.has(listId) ? 'Expand list' : 'Collapse list',
      run: () => toggleCollapsed(listId),
    });
    items.push({ separator: true });
    items.push({ label: 'Remove list', run: () => api.postMessage({ type: 'removeList', listId: listId }) });
    showMenu(anchor, items);
  }

  function showMenu(anchor, items) {
    closeMenu();
    const element = document.createElement('div');
    element.className = 'menu';
    element.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator) {
        element.appendChild(document.createElement('hr'));
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.addEventListener('click', () => {
        closeMenu();
        item.run();
      });
      element.appendChild(button);
    }

    document.body.appendChild(element);
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - element.offsetHeight - 8);
    const left = Math.min(rect.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 8);
    element.style.top = Math.max(8, top) + 'px';
    element.style.left = Math.max(8, left) + 'px';

    menu = element;
    setTimeout(() => document.addEventListener('click', onDocumentClick), 0);
  }

  function onDocumentClick(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
  }

  function closeMenu() {
    document.removeEventListener('click', onDocumentClick);
    if (menu) {
      menu.remove();
      menu = null;
    }
  }

  // ------------------------------------------------------------------ plumbing

  function persist() {
    api.setState({ query: query, tags: [...tagFilter], collapsed: [...collapsedLists] });
  }

  function restore() {
    const saved = api.getState();
    if (!saved) return;
    if (typeof saved.query === 'string') query = saved.query;
    if (Array.isArray(saved.tags)) saved.tags.forEach((tag) => tagFilter.add(String(tag)));
    if (Array.isArray(saved.collapsed)) {
      saved.collapsed.forEach((listId) => collapsedLists.add(String(listId)));
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'state') {
      model = data.state;
      busy = false;
      render();
    } else if (data.type === 'busy') {
      busy = Boolean(data.busy);
      setBusy(busy);
    }
  });

  restore();
  api.postMessage({ type: 'ready' });
})();
