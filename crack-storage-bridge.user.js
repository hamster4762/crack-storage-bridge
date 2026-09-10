// ==UserScript==
// @name         Crack 저장소 공유
// @namespace    local.crack.storage.bridge
// @version      1.0.0
// @description  메인페이지에서 임시 링크·QR로 브라우저 저장 데이터를 한 번 전송합니다.
// @match        https://crack.wrtn.ai/
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  // ── 공통 제한: 작은·중간 크기 저장소용이며 데이터 타입과 DB별 원자적 교체를 담당합니다.
  const ORIGIN = 'https://crack.wrtn.ai';
  const FORMAT = 'crack-storage-bridge';
  const FILE_LIMIT = 64 * 1024 * 1024;
  const PLAIN_LIMIT = 40 * 1024 * 1024;
  const NODE_LIMIT = 400000;
  const RECORD_LIMIT = 200000;
  const typedArrays = Object.fromEntries([
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array',
  ].filter(name => typeof globalThis[name] === 'function').map(name => [name, globalThis[name]]));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const isObject = value => value !== null && typeof value === 'object';
  const isPlain = value => Object.prototype.toString.call(value) === '[object Object]';
  const textBytes = value => new TextEncoder().encode(value);
  const sizeText = bytes => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  const errorText = error => `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message || error}`;

  // ── 바이너리 변환: 큰 배열을 함수 인자로 펼치지 않아 모바일 호출 스택 한도를 피합니다.
  function base64(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 24576) {
      result += btoa(String.fromCharCode(...bytes.subarray(i, i + 24576)));
    }
    return result;
  }

  function unbase64(value, limit = FILE_LIMIT) {
    assert(typeof value === 'string' && value.length <= Math.ceil(limit / 3) * 4 &&
      value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value), '잘못된 바이너리 형식입니다.');
    // 반복 그룹 정규식을 피하여 큰 전송 데이터에서도 정규식 엔진 스택을 소진하지 않습니다.
    const padding = value.indexOf('=');
    assert(padding === -1 || (padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding))), '잘못된 Base64 패딩입니다.');
    const binary = atob(value);
    assert(binary.length <= limit, '바이너리 크기 제한을 초과했습니다.');
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  // ── 구조화 복제 직렬화: JSON에서 손실되는 타입과 순환·공유 참조를 명시적 노드로 보존합니다.
  async function encodeGraph(root) {
    const seen = new Map();
    const nodes = [];
    const queue = [];
    let allocatedSlots = 0;
    function token(value) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['p', value];
      if (value === undefined) return ['u'];
      if (typeof value === 'number') return ['n', Object.is(value, -0) ? '-0' : String(value)];
      if (typeof value === 'bigint') return ['b', String(value)];
      assert(typeof value === 'object', '지원하지 않는 값 타입입니다.');
      if (seen.has(value)) return ['r', seen.get(value)];
      assert(nodes.length < NODE_LIMIT, '데이터 구조가 너무 큽니다. DB를 나눠 전송해 주세요.');
      const id = nodes.length;
      seen.set(value, id);
      nodes.push(null);
      queue.push(value);
      return ['r', id];
    }
    const rootToken = token(root);
    for (let id = 0; id < queue.length; id++) {
      const value = queue[id];
      const tag = Object.prototype.toString.call(value);
      if (Array.isArray(value)) {
        allocatedSlots += value.length;
        assert(allocatedSlots <= RECORD_LIMIT * 10, '전체 배열 크기 제한을 초과했습니다.');
        nodes[id] = ['array', value.length, Object.keys(value).map(key => [key, token(value[key])])];
      }
      else if (tag === '[object Object]') nodes[id] = ['object', Object.keys(value).map(key => [key, token(value[key])])];
      else if (tag === '[object Date]') nodes[id] = ['date', token(value.getTime())];
      else if (tag === '[object RegExp]') {
        assert(value.source.length <= 1000000, '정규식 데이터가 너무 큽니다.');
        nodes[id] = ['regexp', value.source, value.flags];
      }
      else if (tag === '[object Map]') nodes[id] = ['map', Array.from(value, ([key, item]) => [token(key), token(item)])];
      else if (tag === '[object Set]') nodes[id] = ['set', Array.from(value, token)];
      else if (tag === '[object ArrayBuffer]') nodes[id] = ['buffer', base64(new Uint8Array(value))];
      else if (ArrayBuffer.isView(value)) nodes[id] = ['view', tag.slice(8, -1), token(value.buffer), value.byteOffset, value.byteLength];
      else if (tag === '[object Blob]' || tag === '[object File]') {
        assert(value.size <= PLAIN_LIMIT, '전송 데이터/Blob이 너무 큽니다.');
        nodes[id] = ['blob', base64(new Uint8Array(await value.arrayBuffer())), value.type,
          tag === '[object File]' ? value.name : null, tag === '[object File]' ? value.lastModified : null];
      } else throw new Error(`지원하지 않는 저장 값 ${tag}: 원본은 변경하지 않습니다.`);
    }
    return { root: rootToken, nodes };
  }

  // ── 역직렬화: 생성자는 허용 목록만 사용하고 __proto__도 일반 데이터 속성으로 복원합니다.
  function decodeGraph(graph) {
    assert(isPlain(graph) && Array.isArray(graph.nodes) && graph.nodes.length <= NODE_LIMIT, '잘못된 데이터 구조입니다.');
    const nodes = graph.nodes;
    const values = new Array(nodes.length);
    let allocatedSlots = 0;
    function untoken(item) {
      assert(Array.isArray(item), '잘못된 값 토큰입니다.');
      const [type, value] = item;
      if (type === 'u' && item.length === 1) return undefined;
      assert(item.length === 2, '잘못된 값 토큰 길이입니다.');
      if (type === 'p' && (value === null || typeof value === 'string' || typeof value === 'boolean')) return value;
      if (type === 'n' && typeof value === 'string' && (['NaN', 'Infinity', '-Infinity', '-0'].includes(value) || String(Number(value)) === value)) return Number(value);
      if (type === 'b' && typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value) && value.length <= 100000) return BigInt(value);
      if (type === 'r' && Number.isInteger(value) && value >= 0 && value < nodes.length) return values[value];
      throw new Error('지원하지 않는 값 토큰입니다.');
    }
    function pairs(items) {
      assert(Array.isArray(items) && items.length <= NODE_LIMIT, '잘못된 속성 목록입니다.');
      items.forEach(item => assert(Array.isArray(item) && item.length === 2, '잘못된 속성입니다.'));
      return items;
    }
    nodes.forEach((node, id) => {
      assert(Array.isArray(node) && typeof node[0] === 'string', '잘못된 노드입니다.');
      const [type, a, b, c, d] = node;
      const arities = { object: 2, array: 3, map: 2, set: 2, date: 2, regexp: 3, buffer: 2, view: 5, blob: 5 };
      assert(Object.hasOwn(arities, type) && node.length === arities[type], '잘못된 노드 길이입니다.');
      switch (type) {
        case 'object': values[id] = {}; break;
        case 'array':
          assert(Number.isInteger(a) && a >= 0 && a <= RECORD_LIMIT * 10, '배열 크기 제한을 초과했습니다.');
          allocatedSlots += a;
          assert(allocatedSlots <= RECORD_LIMIT * 10, '전체 배열 크기 제한을 초과했습니다.');
          values[id] = new Array(a); break;
        case 'map': values[id] = new Map(); break;
        case 'set': values[id] = new Set(); break;
        case 'date':
          assert(Array.isArray(a) && a[0] === 'n', '잘못된 날짜입니다.');
          values[id] = new Date(untoken(a)); break;
        case 'regexp':
          assert(typeof a === 'string' && a.length <= 1000000 && typeof b === 'string', '잘못된 정규식입니다.');
          values[id] = new RegExp(a, b); break;
        case 'buffer': values[id] = unbase64(a, PLAIN_LIMIT).buffer; break;
        case 'view': break; // ArrayBuffer 노드를 먼저 만든 뒤 연결합니다.
        case 'blob':
          assert(typeof b === 'string' && (c === null || typeof c === 'string') && (d === null || Number.isFinite(d)), '잘못된 Blob입니다.');
          values[id] = c === null ? new Blob([unbase64(a, PLAIN_LIMIT)], { type: b }) : new File([unbase64(a, PLAIN_LIMIT)], c, { type: b, lastModified: d });
          break;
        default: throw new Error(`지원하지 않는 노드: ${type}`);
      }
    });
    nodes.forEach((node, id) => {
      if (node[0] !== 'view') return;
      const [, type, ref, offset, length] = node;
      const buffer = untoken(ref);
      assert(buffer instanceof ArrayBuffer && Number.isSafeInteger(offset) && offset >= 0 &&
        Number.isSafeInteger(length) && length >= 0 && offset + length <= buffer.byteLength, '잘못된 바이너리 뷰입니다.');
      if (type === 'DataView') values[id] = new DataView(buffer, offset, length);
      else {
        assert(Object.hasOwn(typedArrays, type), '지원하지 않는 TypedArray입니다.');
        const Type = typedArrays[type];
        assert(length % Type.BYTES_PER_ELEMENT === 0, '잘못된 TypedArray 길이입니다.');
        values[id] = new Type(buffer, offset, length / Type.BYTES_PER_ELEMENT);
      }
    });
    nodes.forEach((node, id) => {
      const [type, a, b] = node;
      if (type === 'object' || type === 'array') {
        const keys = new Set();
        for (const [key, value] of pairs(type === 'array' ? b : a)) {
          assert(typeof key === 'string' && !keys.has(key) && !(type === 'array' && key === 'length'), '중복되거나 잘못된 속성입니다.');
          if (type === 'array' && /^(0|[1-9]\d*)$/.test(key)) assert(Number(key) < a, '배열 범위가 잘못되었습니다.');
          keys.add(key);
          Object.defineProperty(values[id], key, { value: untoken(value), enumerable: true, writable: true, configurable: true });
        }
      } else if (type === 'map') pairs(a).forEach(([key, value]) => values[id].set(untoken(key), untoken(value)));
      else if (type === 'set') {
        assert(Array.isArray(a), '잘못된 Set입니다.');
        a.forEach(value => values[id].add(untoken(value)));
      }
    });
    return untoken(graph.root);
  }

  // ── 입력 검증: 전체 전송 데이터를 검사한 뒤에만 복원 후보로 사용하며 같은 오리진만 허용합니다.
  function validateDocument(doc) {
    assert(isPlain(doc) && doc.format === FORMAT && doc.version === 1 && doc.origin === ORIGIN && location.origin === ORIGIN,
      '이 데이터는 https://crack.wrtn.ai 전용 백업이어야 합니다.');
    assert(['transfer', 'recovery'].includes(doc.purpose) && typeof doc.createdAt === 'string', '잘못된 백업 정보입니다.');
    assert(Array.isArray(doc.local) && Array.isArray(doc.databases) && doc.local.length + doc.databases.length <= 20000,
      '백업 항목 수가 잘못되었습니다.');
    unique(doc.local.map(item => item?.key), 'Local Storage 키');
    unique(doc.databases.map(item => item?.name), 'DB 이름');
    for (const item of doc.local) {
      assert(isPlain(item) && (typeof item.value === 'string' || (doc.purpose === 'recovery' && item.value === null)), '잘못된 Local Storage 값입니다.');
    }
    let records = 0;
    for (const db of doc.databases) {
      assert(isPlain(db) && Number.isSafeInteger(db.version) && db.version >= 1 && Array.isArray(db.stores) && db.stores.length <= 1000, '잘못된 DB 구조입니다.');
      assert(db.wasAbsent === undefined || (doc.purpose === 'recovery' && db.wasAbsent === true), '잘못된 복구 DB 정보입니다.');
      unique(db.stores.map(store => store?.name), '스토어 이름');
      for (const store of db.stores) {
        assert(isPlain(store) && validKeyPath(store.keyPath) && typeof store.autoIncrement === 'boolean' &&
          Array.isArray(store.indexes) && store.indexes.length <= 1000 && Array.isArray(store.records), '잘못된 스토어 구조입니다.');
        assert(!store.autoIncrement || (store.keyPath !== '' && !Array.isArray(store.keyPath)), '잘못된 자동 증가 키 설정입니다.');
        unique(store.indexes.map(index => index?.name), '인덱스 이름');
        for (const index of store.indexes) assert(isPlain(index) && index.keyPath !== null && validKeyPath(index.keyPath) &&
          typeof index.unique === 'boolean' && typeof index.multiEntry === 'boolean' && !(Array.isArray(index.keyPath) && index.multiEntry), '잘못된 인덱스입니다.');
        records += store.records.length;
        assert(records <= RECORD_LIMIT, '레코드는 전송 데이터당 200,000개 이하여야 합니다.');
        let previous;
        for (let i = 0; i < store.records.length; i++) {
          const record = store.records[i];
          assert(isPlain(record) && Object.hasOwn(record, 'key') && Object.hasOwn(record, 'value'), '잘못된 레코드입니다.');
          indexedDB.cmp(record.key, record.key); // 브라우저 자체의 IDB 키 검증을 사용합니다.
          if (i > 0) assert(indexedDB.cmp(previous, record.key) < 0, '레코드 키 순서가 잘못되었거나 중복되었습니다.');
          if (store.keyPath !== null) assert(indexedDB.cmp(readKeyPath(record.value, store.keyPath), record.key) === 0, '레코드 내부 키가 기본 키와 다릅니다.');
          previous = record.key;
        }
      }
    }
  }

  function unique(values, label) {
    assert(values.every(value => typeof value === 'string') && new Set(values).size === values.length, `${label}이 잘못되었거나 중복되었습니다.`);
  }

  function validKeyPath(path) {
    return path === null || typeof path === 'string' || (Array.isArray(path) && path.length > 0 && path.every(part => typeof part === 'string'));
  }

  function readKeyPath(value, path) {
    if (Array.isArray(path)) return path.map(part => readKeyPath(value, part));
    if (path === '') return value;
    return path.split('.').reduce((current, key) => current == null ? undefined : current[key], value);
  }

  // ── DB 열기: 조회 중 없는 DB를 생성하지 않습니다. 지연된 요청도 후에 생성·업그레이드하지 못하게 합니다.
  function openExisting(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      let settled = false;
      let missing = false;
      const timer = setTimeout(() => fail(new Error(`DB 열기 시간 초과: ${name}. 다른 탭을 닫아 주세요.`)), 8000);
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
      request.onblocked = () => fail(new Error(`다른 연결이 DB를 막고 있습니다: ${name}`));
      request.onerror = () => {
        if (missing && !settled) { settled = true; clearTimeout(timer); resolve(null); }
        else fail(request.error || new Error(`DB 열기 실패: ${name}`));
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (settled) { db.close(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(db);
      };
    });
  }

  function schemaOf(db, transaction) {
    return { name: db.name, version: db.version, stores: Array.from(db.objectStoreNames, name => {
      const store = transaction.objectStore(name);
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames, indexName => {
          const index = store.index(indexName);
          return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }) };
    }) };
  }

  function schemaSignature(db) {
    return JSON.stringify({ name: db.name, version: db.version, stores: db.stores.map(store => ({
      name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
      indexes: store.indexes.map(index => ({ name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
  }

  // ── DB 스냅샷: 모든 스토어를 하나의 읽기 트랜잭션에서 읽습니다. 비동기 암호화는 종료 후 수행합니다.
  async function readDatabase(name, metadataOnly = false, previewLimit = null) {
    const db = await openExisting(name);
    if (!db) return null;
    try {
      if (!db.objectStoreNames.length) return { name: db.name, version: db.version, stores: [] };
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(Array.from(db.objectStoreNames), 'readonly');
        const result = schemaOf(db, transaction);
        let failure;
        let count = 0;
        transaction.onabort = () => reject(failure || transaction.error || new Error(`DB 읽기 중단: ${name}`));
        transaction.onerror = () => {}; // abort에서 오류를 한 번만 보고합니다.
        transaction.oncomplete = () => resolve(result);
        if (metadataOnly) return;
        for (const store of result.stores) {
          store.records = [];
          const request = transaction.objectStore(store.name).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (++count > RECORD_LIMIT) { failure = new Error(`DB ${name}: 레코드 제한 초과`); transaction.abort(); return; }
            store.records.push({ key: cursor.primaryKey, value: cursor.value });
            if (previewLimit === null || store.records.length < previewLimit) cursor.continue();
          };
        }
      });
    } finally { db.close(); }
  }

  // ── 내보내기와 복구 스냅샷: 선택하지 않은 Local Storage 키와 DB에는 쓰지 않습니다.
  function makeDocument(local, databases, purpose = 'transfer') {
    return { format: FORMAT, version: 1, origin: ORIGIN, purpose, createdAt: new Date().toISOString(), local, databases };
  }

  async function snapshotSelection(items) {
    const local = [];
    const databases = [];
    for (const item of items) {
      if (item.kind === 'local') {
        const value = localStorage.getItem(item.name);
        assert(value !== null, `키가 사라졌습니다. 목록을 다시 읽어 주세요: ${item.name}`);
        local.push({ key: item.name, value });
      } else {
        const db = await readDatabase(item.name);
        assert(db, `DB가 사라졌습니다: ${item.name}`);
        databases.push(db);
      }
    }
    const doc = makeDocument(local, databases);
    validateDocument(doc);
    return doc;
  }

  async function recoverySnapshot(incoming) {
    const local = incoming.local.map(item => ({ key: item.key, value: localStorage.getItem(item.key) }));
    const databases = [];
    for (const source of incoming.databases) {
      const current = await readDatabase(source.name);
      if (current) {
        assert(schemaSignature(current) === schemaSignature(source), `DB 버전/구조가 다릅니다: ${source.name}. 양쪽 스크립트 버전을 맞추고 다시 시도해 주세요.`);
        databases.push(current);
      } else {
        databases.push({ ...source, wasAbsent: true, stores: source.stores.map(store => ({ ...store, records: [] })) });
      }
    }
    const doc = makeDocument(local, databases, 'recovery');
    validateDocument(doc);
    return doc;
  }

  // ── 레코드 전체 교체: clear와 add를 같은 트랜잭션에 넣어 실패하면 해당 DB가 원래 상태로 돌아갑니다.
  function enqueueReplacement(transaction, source) {
    for (const data of source.stores) {
      const store = transaction.objectStore(data.name);
      store.clear();
      for (const record of data.records) {
        if (store.keyPath === null) store.add(record.value, record.key);
        else store.add(record.value);
      }
    }
  }

  async function replaceDatabase(source) {
    const db = await openExisting(source.name);
    if (!db) return source.wasAbsent ? undefined : createDatabase(source);
    try {
      if (!db.objectStoreNames.length) {
        assert(schemaSignature({ name: db.name, version: db.version, stores: [] }) === schemaSignature(source), `DB 구조가 변경되었습니다: ${source.name}`);
        return;
      }
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(Array.from(db.objectStoreNames), 'readwrite');
        let failure;
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(failure || transaction.error || new Error(`DB 쓰기 중단: ${source.name}`));
        transaction.onerror = () => {};
        try {
          assert(schemaSignature(schemaOf(db, transaction)) === schemaSignature(source), `DB 구조가 변경되었습니다: ${source.name}`);
          enqueueReplacement(transaction, source);
        } catch (error) { failure = error; transaction.abort(); }
      });
    } finally { db.close(); }
  }

  // ── 없는 DB만 생성: 최초 생성과 데이터 기록도 하나의 upgrade 트랜잭션으로 처리합니다.
  function createDatabase(source) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failure;
      let created = false;
      const request = indexedDB.open(source.name, source.version);
      const timer = setTimeout(() => finish(new Error(`DB 생성 대기 시간 초과: ${source.name}`)), 8000);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      }
      request.onblocked = () => finish(new Error(`DB 생성이 차단되었습니다: ${source.name}. 다른 탭을 닫아 주세요.`));
      request.onupgradeneeded = event => {
        // 쓰기가 시작되면 완료/abort를 끝까지 기다립니다. 커밋 직후 시간 초과로 오보하지 않습니다.
        clearTimeout(timer);
        if (settled || event.oldVersion !== 0) {
          failure = new Error(`동시에 DB가 생성/변경되었습니다: ${source.name}`);
          request.transaction.abort();
          return;
        }
        try {
          created = true;
          for (const data of source.stores) {
            const store = request.result.createObjectStore(data.name, { keyPath: data.keyPath, autoIncrement: data.autoIncrement });
            for (const index of data.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
          }
          enqueueReplacement(request.transaction, source);
        } catch (error) { failure = error; request.transaction.abort(); }
      };
      request.onerror = () => finish(failure || request.error);
      request.onsuccess = () => {
        request.result.close();
        finish(created ? null : new Error(`동시에 같은 DB가 생성되었습니다: ${source.name}. 다시 준비해 주세요.`));
      };
    });
  }

  // ── Local Storage의 보상 복구: 여러 키의 원자적 쓰기 API가 없으므로 실패하면 기존 값을 돌려놓습니다.
  function replaceLocal(items, before) {
    const changed = [];
    try {
      for (const item of items) {
        item.value === null ? localStorage.removeItem(item.key) : localStorage.setItem(item.key, item.value);
        changed.push(item.key);
      }
    } catch (error) {
      const errors = [];
      for (const key of changed.reverse()) {
        const value = before.find(item => item.key === key).value;
        try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); }
        catch { errors.push(key); }
      }
      throw new Error(`${errorText(error)}. ${errors.length ? `Local Storage 되돌리기도 실패: ${errors.join(', ')}` : '이번 Local Storage 쓰기는 되돌렸습니다.'}`);
    }
  }

  // ── 복원 실행: 준비 이후 변경을 재검사하고, DB별 완료 내역을 기록합니다. 전체 원자성은 주장하지 않습니다.
  async function restore(incoming, before, progress = () => {}, cancelled = () => false) {
    const completed = [];
    try {
      const fresh = await recoverySnapshot(incoming);
      const snapshotBody = doc => ({ local: doc.local, databases: doc.databases });
      assert(JSON.stringify(await encodeGraph(snapshotBody(fresh))) === JSON.stringify(await encodeGraph(snapshotBody(before))),
        '되돌리기 준비 이후 대상 데이터가 바뀌었습니다. 다른 스크립트를 중지하고 다시 시도해 주세요.');
      for (const db of incoming.databases) {
        assert(!cancelled(), '페이지가 바뀌어 다음 저장을 중단했습니다.');
        progress(`DB 교체 중: ${db.name}`);
        await replaceDatabase(db);
        completed.push(`DB: ${db.name}`);
      }
      assert(!cancelled(), '페이지가 바뀌어 다음 저장을 중단했습니다.');
      replaceLocal(incoming.local, before.local);
      if (incoming.local.length) completed.push(`Local Storage ${incoming.local.length}개`);
      return completed;
    } catch (error) {
      throw new Error(`${errorText(error)}\n완료된 항목: ${completed.length ? completed.join(', ') : '없음'}\n이미 완료된 DB는 유지됩니다. 이 창의 되돌리기로 이전 데이터로 복구할 수 있습니다.`);
    }
  }

/*
 * QR Code generator library (compiled from TypeScript)
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */
"use strict";
var qrcodegen;
(function (qrcodegen) {
    /*---- QR Code symbol class ----*/
    /*
     * A QR Code symbol, which is a type of two-dimension barcode.
     * Invented by Denso Wave and described in the ISO/IEC 18004 standard.
     * Instances of this class represent an immutable square grid of dark and light cells.
     * The class provides static factory functions to create a QR Code from text or binary data.
     * The class covers the QR Code Model 2 specification, supporting all versions (sizes)
     * from 1 to 40, all 4 error correction levels, and 4 character encoding modes.
     *
     * Ways to create a QR Code object:
     * - High level: Take the payload data and call QrCode.encodeText() or QrCode.encodeBinary().
     * - Mid level: Custom-make the list of segments and call QrCode.encodeSegments().
     * - Low level: Custom-make the array of data codeword bytes (including
     *   segment headers and final padding, excluding error correction codewords),
     *   supply the appropriate version number, and call the QrCode() constructor.
     * (Note that all ways require supplying the desired error correction level.)
     */
    class QrCode {
        /*-- Constructor (low level) and fields --*/
        // Creates a new QR Code with the given version number,
        // error correction level, data codeword bytes, and mask number.
        // This is a low-level API that most users should not use directly.
        // A mid-level API is the encodeSegments() function.
        constructor(
        // The version number of this QR Code, which is between 1 and 40 (inclusive).
        // This determines the size of this barcode.
        version, 
        // The error correction level used in this QR Code.
        errorCorrectionLevel, dataCodewords, msk) {
            this.version = version;
            this.errorCorrectionLevel = errorCorrectionLevel;
            // The modules of this QR Code (false = light, true = dark).
            // Immutable after constructor finishes. Accessed through getModule().
            this.modules = [];
            // Indicates function modules that are not subjected to masking. Discarded when constructor finishes.
            this.isFunction = [];
            // Check scalar arguments
            if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION)
                throw new RangeError("Version value out of range");
            if (msk < -1 || msk > 7)
                throw new RangeError("Mask value out of range");
            this.size = version * 4 + 17;
            // Initialize both grids to be size*size arrays of Boolean false
            let row = [];
            for (let i = 0; i < this.size; i++)
                row.push(false);
            for (let i = 0; i < this.size; i++) {
                this.modules.push(row.slice()); // Initially all light
                this.isFunction.push(row.slice());
            }
            // Compute ECC, draw modules
            this.drawFunctionPatterns();
            const allCodewords = this.addEccAndInterleave(dataCodewords);
            this.drawCodewords(allCodewords);
            // Do masking
            if (msk == -1) { // Automatically choose best mask
                let minPenalty = 1000000000;
                for (let i = 0; i < 8; i++) {
                    this.applyMask(i);
                    this.drawFormatBits(i);
                    const penalty = this.getPenaltyScore();
                    if (penalty < minPenalty) {
                        msk = i;
                        minPenalty = penalty;
                    }
                    this.applyMask(i); // Undoes the mask due to XOR
                }
            }
            assert(0 <= msk && msk <= 7);
            this.mask = msk;
            this.applyMask(msk); // Apply the final choice of mask
            this.drawFormatBits(msk); // Overwrite old format bits
            this.isFunction = [];
        }
        /*-- Static factory functions (high level) --*/
        // Returns a QR Code representing the given Unicode text string at the given error correction level.
        // As a conservative upper bound, this function is guaranteed to succeed for strings that have 738 or fewer
        // Unicode code points (not UTF-16 code units) if the low error correction level is used. The smallest possible
        // QR Code version is automatically chosen for the output. The ECC level of the result may be higher than the
        // ecl argument if it can be done without increasing the version.
        static encodeText(text, ecl) {
            const segs = qrcodegen.QrSegment.makeSegments(text);
            return QrCode.encodeSegments(segs, ecl);
        }
        // Returns a QR Code representing the given binary data at the given error correction level.
        // This function always encodes using the binary segment mode, not any text mode. The maximum number of
        // bytes allowed is 2953. The smallest possible QR Code version is automatically chosen for the output.
        // The ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
        static encodeBinary(data, ecl) {
            const seg = qrcodegen.QrSegment.makeBytes(data);
            return QrCode.encodeSegments([seg], ecl);
        }
        /*-- Static factory functions (mid level) --*/
        // Returns a QR Code representing the given segments with the given encoding parameters.
        // The smallest possible QR Code version within the given range is automatically
        // chosen for the output. Iff boostEcl is true, then the ECC level of the result
        // may be higher than the ecl argument if it can be done without increasing the
        // version. The mask number is either between 0 to 7 (inclusive) to force that
        // mask, or -1 to automatically choose an appropriate mask (which may be slow).
        // This function allows the user to create a custom sequence of segments that switches
        // between modes (such as alphanumeric and byte) to encode text in less space.
        // This is a mid-level API; the high-level API is encodeText() and encodeBinary().
        static encodeSegments(segs, ecl, minVersion = 1, maxVersion = 40, mask = -1, boostEcl = true) {
            if (!(QrCode.MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= QrCode.MAX_VERSION)
                || mask < -1 || mask > 7)
                throw new RangeError("Invalid value");
            // Find the minimal version number to use
            let version;
            let dataUsedBits;
            for (version = minVersion;; version++) {
                const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8; // Number of data bits available
                const usedBits = QrSegment.getTotalBits(segs, version);
                if (usedBits <= dataCapacityBits) {
                    dataUsedBits = usedBits;
                    break; // This version number is found to be suitable
                }
                if (version >= maxVersion) // All versions in the range could not fit the given data
                    throw new RangeError("Data too long");
            }
            // Increase the error correction level while the data still fits in the current version number
            for (const newEcl of [QrCode.Ecc.MEDIUM, QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH]) { // From low to high
                if (boostEcl && dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8)
                    ecl = newEcl;
            }
            // Concatenate all segments to create the data bit string
            let bb = [];
            for (const seg of segs) {
                appendBits(seg.mode.modeBits, 4, bb);
                appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
                for (const b of seg.getData())
                    bb.push(b);
            }
            assert(bb.length == dataUsedBits);
            // Add terminator and pad up to a byte if applicable
            const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
            assert(bb.length <= dataCapacityBits);
            appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
            appendBits(0, (8 - bb.length % 8) % 8, bb);
            assert(bb.length % 8 == 0);
            // Pad with alternating bytes until data capacity is reached
            for (let padByte = 0xEC; bb.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11)
                appendBits(padByte, 8, bb);
            // Pack bits into bytes in big endian
            let dataCodewords = [];
            while (dataCodewords.length * 8 < bb.length)
                dataCodewords.push(0);
            bb.forEach((b, i) => dataCodewords[i >>> 3] |= b << (7 - (i & 7)));
            // Create the QR Code object
            return new QrCode(version, ecl, dataCodewords, mask);
        }
        /*-- Accessor methods --*/
        // Returns the color of the module (pixel) at the given coordinates, which is false
        // for light or true for dark. The top left corner has the coordinates (x=0, y=0).
        // If the given coordinates are out of bounds, then false (light) is returned.
        getModule(x, y) {
            return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
        }
        /*-- Private helper methods for constructor: Drawing function modules --*/
        // Reads this object's version field, and draws and marks all function modules.
        drawFunctionPatterns() {
            // Draw horizontal and vertical timing patterns
            for (let i = 0; i < this.size; i++) {
                this.setFunctionModule(6, i, i % 2 == 0);
                this.setFunctionModule(i, 6, i % 2 == 0);
            }
            // Draw 3 finder patterns (all corners except bottom right; overwrites some timing modules)
            this.drawFinderPattern(3, 3);
            this.drawFinderPattern(this.size - 4, 3);
            this.drawFinderPattern(3, this.size - 4);
            // Draw numerous alignment patterns
            const alignPatPos = this.getAlignmentPatternPositions();
            const numAlign = alignPatPos.length;
            for (let i = 0; i < numAlign; i++) {
                for (let j = 0; j < numAlign; j++) {
                    // Don't draw on the three finder corners
                    if (!(i == 0 && j == 0 || i == 0 && j == numAlign - 1 || i == numAlign - 1 && j == 0))
                        this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
                }
            }
            // Draw configuration data
            this.drawFormatBits(0); // Dummy mask value; overwritten later in the constructor
            this.drawVersion();
        }
        // Draws two copies of the format bits (with its own error correction code)
        // based on the given mask and this object's error correction level field.
        drawFormatBits(mask) {
            // Calculate error correction code and pack bits
            const data = this.errorCorrectionLevel.formatBits << 3 | mask; // errCorrLvl is uint2, mask is uint3
            let rem = data;
            for (let i = 0; i < 10; i++)
                rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const bits = (data << 10 | rem) ^ 0x5412; // uint15
            assert(bits >>> 15 == 0);
            // Draw first copy
            for (let i = 0; i <= 5; i++)
                this.setFunctionModule(8, i, getBit(bits, i));
            this.setFunctionModule(8, 7, getBit(bits, 6));
            this.setFunctionModule(8, 8, getBit(bits, 7));
            this.setFunctionModule(7, 8, getBit(bits, 8));
            for (let i = 9; i < 15; i++)
                this.setFunctionModule(14 - i, 8, getBit(bits, i));
            // Draw second copy
            for (let i = 0; i < 8; i++)
                this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
            for (let i = 8; i < 15; i++)
                this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
            this.setFunctionModule(8, this.size - 8, true); // Always dark
        }
        // Draws two copies of the version bits (with its own error correction code),
        // based on this object's version field, iff 7 <= version <= 40.
        drawVersion() {
            if (this.version < 7)
                return;
            // Calculate error correction code and pack bits
            let rem = this.version; // version is uint6, in the range [7, 40]
            for (let i = 0; i < 12; i++)
                rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            const bits = this.version << 12 | rem; // uint18
            assert(bits >>> 18 == 0);
            // Draw two copies
            for (let i = 0; i < 18; i++) {
                const color = getBit(bits, i);
                const a = this.size - 11 + i % 3;
                const b = Math.floor(i / 3);
                this.setFunctionModule(a, b, color);
                this.setFunctionModule(b, a, color);
            }
        }
        // Draws a 9*9 finder pattern including the border separator,
        // with the center module at (x, y). Modules can be out of bounds.
        drawFinderPattern(x, y) {
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev/infinity norm
                    const xx = x + dx;
                    const yy = y + dy;
                    if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
                        this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
                }
            }
        }
        // Draws a 5*5 alignment pattern, with the center module
        // at (x, y). All modules must be in bounds.
        drawAlignmentPattern(x, y) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++)
                    this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
            }
        }
        // Sets the color of a module and marks it as a function module.
        // Only used by the constructor. Coordinates must be in bounds.
        setFunctionModule(x, y, isDark) {
            this.modules[y][x] = isDark;
            this.isFunction[y][x] = true;
        }
        /*-- Private helper methods for constructor: Codewords and masking --*/
        // Returns a new byte string representing the given data with the appropriate error correction
        // codewords appended to it, based on this object's version and error correction level.
        addEccAndInterleave(data) {
            const ver = this.version;
            const ecl = this.errorCorrectionLevel;
            if (data.length != QrCode.getNumDataCodewords(ver, ecl))
                throw new RangeError("Invalid argument");
            // Calculate parameter numbers
            const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
            const blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
            const rawCodewords = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
            const numShortBlocks = numBlocks - rawCodewords % numBlocks;
            const shortBlockLen = Math.floor(rawCodewords / numBlocks);
            // Split data into blocks and append ECC to each block
            let blocks = [];
            const rsDiv = QrCode.reedSolomonComputeDivisor(blockEccLen);
            for (let i = 0, k = 0; i < numBlocks; i++) {
                let dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
                k += dat.length;
                const ecc = QrCode.reedSolomonComputeRemainder(dat, rsDiv);
                if (i < numShortBlocks)
                    dat.push(0);
                blocks.push(dat.concat(ecc));
            }
            // Interleave (not concatenate) the bytes from every block into a single sequence
            let result = [];
            for (let i = 0; i < blocks[0].length; i++) {
                blocks.forEach((block, j) => {
                    // Skip the padding byte in short blocks
                    if (i != shortBlockLen - blockEccLen || j >= numShortBlocks)
                        result.push(block[i]);
                });
            }
            assert(result.length == rawCodewords);
            return result;
        }
        // Draws the given sequence of 8-bit codewords (data and error correction) onto the entire
        // data area of this QR Code. Function modules need to be marked off before this is called.
        drawCodewords(data) {
            if (data.length != Math.floor(QrCode.getNumRawDataModules(this.version) / 8))
                throw new RangeError("Invalid argument");
            let i = 0; // Bit index into the data
            // Do the funny zigzag scan
            for (let right = this.size - 1; right >= 1; right -= 2) { // Index of right column in each column pair
                if (right == 6)
                    right = 5;
                for (let vert = 0; vert < this.size; vert++) { // Vertical counter
                    for (let j = 0; j < 2; j++) {
                        const x = right - j; // Actual x coordinate
                        const upward = ((right + 1) & 2) == 0;
                        const y = upward ? this.size - 1 - vert : vert; // Actual y coordinate
                        if (!this.isFunction[y][x] && i < data.length * 8) {
                            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                            i++;
                        }
                        // If this QR Code has any remainder bits (0 to 7), they were assigned as
                        // 0/false/light by the constructor and are left unchanged by this method
                    }
                }
            }
            assert(i == data.length * 8);
        }
        // XORs the codeword modules in this QR Code with the given mask pattern.
        // The function modules must be marked and the codeword bits must be drawn
        // before masking. Due to the arithmetic of XOR, calling applyMask() with
        // the same mask value a second time will undo the mask. A final well-formed
        // QR Code needs exactly one (not zero, two, etc.) mask applied.
        applyMask(mask) {
            if (mask < 0 || mask > 7)
                throw new RangeError("Mask value out of range");
            for (let y = 0; y < this.size; y++) {
                for (let x = 0; x < this.size; x++) {
                    let invert;
                    switch (mask) {
                        case 0:
                            invert = (x + y) % 2 == 0;
                            break;
                        case 1:
                            invert = y % 2 == 0;
                            break;
                        case 2:
                            invert = x % 3 == 0;
                            break;
                        case 3:
                            invert = (x + y) % 3 == 0;
                            break;
                        case 4:
                            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0;
                            break;
                        case 5:
                            invert = x * y % 2 + x * y % 3 == 0;
                            break;
                        case 6:
                            invert = (x * y % 2 + x * y % 3) % 2 == 0;
                            break;
                        case 7:
                            invert = ((x + y) % 2 + x * y % 3) % 2 == 0;
                            break;
                        default: throw new Error("Unreachable");
                    }
                    if (!this.isFunction[y][x] && invert)
                        this.modules[y][x] = !this.modules[y][x];
                }
            }
        }
        // Calculates and returns the penalty score based on state of this QR Code's current modules.
        // This is used by the automatic mask choice algorithm to find the mask pattern that yields the lowest score.
        getPenaltyScore() {
            let result = 0;
            // Adjacent modules in row having same color, and finder-like patterns
            for (let y = 0; y < this.size; y++) {
                let runColor = false;
                let runX = 0;
                let runHistory = [0, 0, 0, 0, 0, 0, 0];
                for (let x = 0; x < this.size; x++) {
                    if (this.modules[y][x] == runColor) {
                        runX++;
                        if (runX == 5)
                            result += QrCode.PENALTY_N1;
                        else if (runX > 5)
                            result++;
                    }
                    else {
                        this.finderPenaltyAddHistory(runX, runHistory);
                        if (!runColor)
                            result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
                        runColor = this.modules[y][x];
                        runX = 1;
                    }
                }
                result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * QrCode.PENALTY_N3;
            }
            // Adjacent modules in column having same color, and finder-like patterns
            for (let x = 0; x < this.size; x++) {
                let runColor = false;
                let runY = 0;
                let runHistory = [0, 0, 0, 0, 0, 0, 0];
                for (let y = 0; y < this.size; y++) {
                    if (this.modules[y][x] == runColor) {
                        runY++;
                        if (runY == 5)
                            result += QrCode.PENALTY_N1;
                        else if (runY > 5)
                            result++;
                    }
                    else {
                        this.finderPenaltyAddHistory(runY, runHistory);
                        if (!runColor)
                            result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
                        runColor = this.modules[y][x];
                        runY = 1;
                    }
                }
                result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * QrCode.PENALTY_N3;
            }
            // 2*2 blocks of modules having same color
            for (let y = 0; y < this.size - 1; y++) {
                for (let x = 0; x < this.size - 1; x++) {
                    const color = this.modules[y][x];
                    if (color == this.modules[y][x + 1] &&
                        color == this.modules[y + 1][x] &&
                        color == this.modules[y + 1][x + 1])
                        result += QrCode.PENALTY_N2;
                }
            }
            // Balance of dark and light modules
            let dark = 0;
            for (const row of this.modules)
                dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
            const total = this.size * this.size; // Note that size is odd, so dark/total != 1/2
            // Compute the smallest integer k >= 0 such that (45-5k)% <= dark/total <= (55+5k)%
            const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
            assert(0 <= k && k <= 9);
            result += k * QrCode.PENALTY_N4;
            assert(0 <= result && result <= 2568888); // Non-tight upper bound based on default values of PENALTY_N1, ..., N4
            return result;
        }
        /*-- Private helper functions --*/
        // Returns an ascending list of positions of alignment patterns for this version number.
        // Each position is in the range [0,177), and are used on both the x and y axes.
        // This could be implemented as lookup table of 40 variable-length lists of integers.
        getAlignmentPatternPositions() {
            if (this.version == 1)
                return [];
            else {
                const numAlign = Math.floor(this.version / 7) + 2;
                const step = (this.version == 32) ? 26 :
                    Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
                let result = [6];
                for (let pos = this.size - 7; result.length < numAlign; pos -= step)
                    result.splice(1, 0, pos);
                return result;
            }
        }
        // Returns the number of data bits that can be stored in a QR Code of the given version number, after
        // all function modules are excluded. This includes remainder bits, so it might not be a multiple of 8.
        // The result is in the range [208, 29648]. This could be implemented as a 40-entry lookup table.
        static getNumRawDataModules(ver) {
            if (ver < QrCode.MIN_VERSION || ver > QrCode.MAX_VERSION)
                throw new RangeError("Version number out of range");
            let result = (16 * ver + 128) * ver + 64;
            if (ver >= 2) {
                const numAlign = Math.floor(ver / 7) + 2;
                result -= (25 * numAlign - 10) * numAlign - 55;
                if (ver >= 7)
                    result -= 36;
            }
            assert(208 <= result && result <= 29648);
            return result;
        }
        // Returns the number of 8-bit data (i.e. not error correction) codewords contained in any
        // QR Code of the given version number and error correction level, with remainder bits discarded.
        // This stateless pure function could be implemented as a (40*4)-cell lookup table.
        static getNumDataCodewords(ver, ecl) {
            return Math.floor(QrCode.getNumRawDataModules(ver) / 8) -
                QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] *
                    QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
        }
        // Returns a Reed-Solomon ECC generator polynomial for the given degree. This could be
        // implemented as a lookup table over all possible parameter values, instead of as an algorithm.
        static reedSolomonComputeDivisor(degree) {
            if (degree < 1 || degree > 255)
                throw new RangeError("Degree out of range");
            // Polynomial coefficients are stored from highest to lowest power, excluding the leading term which is always 1.
            // For example the polynomial x^3 + 255x^2 + 8x + 93 is stored as the uint8 array [255, 8, 93].
            let result = [];
            for (let i = 0; i < degree - 1; i++)
                result.push(0);
            result.push(1); // Start off with the monomial x^0
            // Compute the product polynomial (x - r^0) * (x - r^1) * (x - r^2) * ... * (x - r^{degree-1}),
            // and drop the highest monomial term which is always 1x^degree.
            // Note that r = 0x02, which is a generator element of this field GF(2^8/0x11D).
            let root = 1;
            for (let i = 0; i < degree; i++) {
                // Multiply the current product by (x - r^i)
                for (let j = 0; j < result.length; j++) {
                    result[j] = QrCode.reedSolomonMultiply(result[j], root);
                    if (j + 1 < result.length)
                        result[j] ^= result[j + 1];
                }
                root = QrCode.reedSolomonMultiply(root, 0x02);
            }
            return result;
        }
        // Returns the Reed-Solomon error correction codeword for the given data and divisor polynomials.
        static reedSolomonComputeRemainder(data, divisor) {
            let result = divisor.map(_ => 0);
            for (const b of data) { // Polynomial division
                const factor = b ^ result.shift();
                result.push(0);
                divisor.forEach((coef, i) => result[i] ^= QrCode.reedSolomonMultiply(coef, factor));
            }
            return result;
        }
        // Returns the product of the two given field elements modulo GF(2^8/0x11D). The arguments and result
        // are unsigned 8-bit integers. This could be implemented as a lookup table of 256*256 entries of uint8.
        static reedSolomonMultiply(x, y) {
            if (x >>> 8 != 0 || y >>> 8 != 0)
                throw new RangeError("Byte out of range");
            // Russian peasant multiplication
            let z = 0;
            for (let i = 7; i >= 0; i--) {
                z = (z << 1) ^ ((z >>> 7) * 0x11D);
                z ^= ((y >>> i) & 1) * x;
            }
            assert(z >>> 8 == 0);
            return z;
        }
        // Can only be called immediately after a light run is added, and
        // returns either 0, 1, or 2. A helper function for getPenaltyScore().
        finderPenaltyCountPatterns(runHistory) {
            const n = runHistory[1];
            assert(n <= this.size * 3);
            const core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
            return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
                + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
        }
        // Must be called at the end of a line (row or column) of modules. A helper function for getPenaltyScore().
        finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
            if (currentRunColor) { // Terminate dark run
                this.finderPenaltyAddHistory(currentRunLength, runHistory);
                currentRunLength = 0;
            }
            currentRunLength += this.size; // Add light border to final run
            this.finderPenaltyAddHistory(currentRunLength, runHistory);
            return this.finderPenaltyCountPatterns(runHistory);
        }
        // Pushes the given value to the front and drops the last value. A helper function for getPenaltyScore().
        finderPenaltyAddHistory(currentRunLength, runHistory) {
            if (runHistory[0] == 0)
                currentRunLength += this.size; // Add light border to initial run
            runHistory.pop();
            runHistory.unshift(currentRunLength);
        }
    }
    /*-- Constants and tables --*/
    // The minimum version number supported in the QR Code Model 2 standard.
    QrCode.MIN_VERSION = 1;
    // The maximum version number supported in the QR Code Model 2 standard.
    QrCode.MAX_VERSION = 40;
    // For use in getPenaltyScore(), when evaluating which mask is best.
    QrCode.PENALTY_N1 = 3;
    QrCode.PENALTY_N2 = 3;
    QrCode.PENALTY_N3 = 40;
    QrCode.PENALTY_N4 = 10;
    QrCode.ECC_CODEWORDS_PER_BLOCK = [
        // Version: (note that index 0 is for padding, and is set to an illegal value)
        //0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
        [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
        [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // High
    ];
    QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
        // Version: (note that index 0 is for padding, and is set to an illegal value)
        //0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
        [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
        [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
        [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
        [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // High
    ];
    qrcodegen.QrCode = QrCode;
    // Appends the given number of low-order bits of the given value
    // to the given buffer. Requires 0 <= len <= 31 and 0 <= val < 2^len.
    function appendBits(val, len, bb) {
        if (len < 0 || len > 31 || val >>> len != 0)
            throw new RangeError("Value out of range");
        for (let i = len - 1; i >= 0; i--) // Append bit by bit
            bb.push((val >>> i) & 1);
    }
    // Returns true iff the i'th bit of x is set to 1.
    function getBit(x, i) {
        return ((x >>> i) & 1) != 0;
    }
    // Throws an exception if the given condition is false.
    function assert(cond) {
        if (!cond)
            throw new Error("Assertion error");
    }
    /*---- Data segment class ----*/
    /*
     * A segment of character/binary/control data in a QR Code symbol.
     * Instances of this class are immutable.
     * The mid-level way to create a segment is to take the payload data
     * and call a static factory function such as QrSegment.makeNumeric().
     * The low-level way to create a segment is to custom-make the bit buffer
     * and call the QrSegment() constructor with appropriate values.
     * This segment class imposes no length restrictions, but QR Codes have restrictions.
     * Even in the most favorable conditions, a QR Code can only hold 7089 characters of data.
     * Any segment longer than this is meaningless for the purpose of generating QR Codes.
     */
    class QrSegment {
        /*-- Constructor (low level) and fields --*/
        // Creates a new QR Code segment with the given attributes and data.
        // The character count (numChars) must agree with the mode and the bit buffer length,
        // but the constraint isn't checked. The given bit buffer is cloned and stored.
        constructor(
        // The mode indicator of this segment.
        mode, 
        // The length of this segment's unencoded data. Measured in characters for
        // numeric/alphanumeric/kanji mode, bytes for byte mode, and 0 for ECI mode.
        // Always zero or positive. Not the same as the data's bit length.
        numChars, 
        // The data bits of this segment. Accessed through getData().
        bitData) {
            this.mode = mode;
            this.numChars = numChars;
            this.bitData = bitData;
            if (numChars < 0)
                throw new RangeError("Invalid argument");
            this.bitData = bitData.slice(); // Make defensive copy
        }
        /*-- Static factory functions (mid level) --*/
        // Returns a segment representing the given binary data encoded in
        // byte mode. All input byte arrays are acceptable. Any text string
        // can be converted to UTF-8 bytes and encoded as a byte mode segment.
        static makeBytes(data) {
            let bb = [];
            for (const b of data)
                appendBits(b, 8, bb);
            return new QrSegment(QrSegment.Mode.BYTE, data.length, bb);
        }
        // Returns a segment representing the given string of decimal digits encoded in numeric mode.
        static makeNumeric(digits) {
            if (!QrSegment.isNumeric(digits))
                throw new RangeError("String contains non-numeric characters");
            let bb = [];
            for (let i = 0; i < digits.length;) { // Consume up to 3 digits per iteration
                const n = Math.min(digits.length - i, 3);
                appendBits(parseInt(digits.substr(i, n), 10), n * 3 + 1, bb);
                i += n;
            }
            return new QrSegment(QrSegment.Mode.NUMERIC, digits.length, bb);
        }
        // Returns a segment representing the given text string encoded in alphanumeric mode.
        // The characters allowed are: 0 to 9, A to Z (uppercase only), space,
        // dollar, percent, asterisk, plus, hyphen, period, slash, colon.
        static makeAlphanumeric(text) {
            if (!QrSegment.isAlphanumeric(text))
                throw new RangeError("String contains unencodable characters in alphanumeric mode");
            let bb = [];
            let i;
            for (i = 0; i + 2 <= text.length; i += 2) { // Process groups of 2
                let temp = QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45;
                temp += QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
                appendBits(temp, 11, bb);
            }
            if (i < text.length) // 1 character remaining
                appendBits(QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6, bb);
            return new QrSegment(QrSegment.Mode.ALPHANUMERIC, text.length, bb);
        }
        // Returns a new mutable list of zero or more segments to represent the given Unicode text string.
        // The result may use various segment modes and switch modes to optimize the length of the bit stream.
        static makeSegments(text) {
            // Select the most efficient segment encoding automatically
            if (text == "")
                return [];
            else if (QrSegment.isNumeric(text))
                return [QrSegment.makeNumeric(text)];
            else if (QrSegment.isAlphanumeric(text))
                return [QrSegment.makeAlphanumeric(text)];
            else
                return [QrSegment.makeBytes(QrSegment.toUtf8ByteArray(text))];
        }
        // Returns a segment representing an Extended Channel Interpretation
        // (ECI) designator with the given assignment value.
        static makeEci(assignVal) {
            let bb = [];
            if (assignVal < 0)
                throw new RangeError("ECI assignment value out of range");
            else if (assignVal < (1 << 7))
                appendBits(assignVal, 8, bb);
            else if (assignVal < (1 << 14)) {
                appendBits(0b10, 2, bb);
                appendBits(assignVal, 14, bb);
            }
            else if (assignVal < 1000000) {
                appendBits(0b110, 3, bb);
                appendBits(assignVal, 21, bb);
            }
            else
                throw new RangeError("ECI assignment value out of range");
            return new QrSegment(QrSegment.Mode.ECI, 0, bb);
        }
        // Tests whether the given string can be encoded as a segment in numeric mode.
        // A string is encodable iff each character is in the range 0 to 9.
        static isNumeric(text) {
            return QrSegment.NUMERIC_REGEX.test(text);
        }
        // Tests whether the given string can be encoded as a segment in alphanumeric mode.
        // A string is encodable iff each character is in the following set: 0 to 9, A to Z
        // (uppercase only), space, dollar, percent, asterisk, plus, hyphen, period, slash, colon.
        static isAlphanumeric(text) {
            return QrSegment.ALPHANUMERIC_REGEX.test(text);
        }
        /*-- Methods --*/
        // Returns a new copy of the data bits of this segment.
        getData() {
            return this.bitData.slice(); // Make defensive copy
        }
        // (Package-private) Calculates and returns the number of bits needed to encode the given segments at
        // the given version. The result is infinity if a segment has too many characters to fit its length field.
        static getTotalBits(segs, version) {
            let result = 0;
            for (const seg of segs) {
                const ccbits = seg.mode.numCharCountBits(version);
                if (seg.numChars >= (1 << ccbits))
                    return Infinity; // The segment's length doesn't fit the field's bit width
                result += 4 + ccbits + seg.bitData.length;
            }
            return result;
        }
        // Returns a new array of bytes representing the given string encoded in UTF-8.
        static toUtf8ByteArray(str) {
            str = encodeURI(str);
            let result = [];
            for (let i = 0; i < str.length; i++) {
                if (str.charAt(i) != "%")
                    result.push(str.charCodeAt(i));
                else {
                    result.push(parseInt(str.substr(i + 1, 2), 16));
                    i += 2;
                }
            }
            return result;
        }
    }
    /*-- Constants --*/
    // Describes precisely all strings that are encodable in numeric mode.
    QrSegment.NUMERIC_REGEX = /^[0-9]*$/;
    // Describes precisely all strings that are encodable in alphanumeric mode.
    QrSegment.ALPHANUMERIC_REGEX = /^[A-Z0-9 $%*+.\/:-]*$/;
    // The set of all legal characters in alphanumeric mode,
    // where each character value maps to the index in the string.
    QrSegment.ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
    qrcodegen.QrSegment = QrSegment;
})(qrcodegen || (qrcodegen = {}));
/*---- Public helper enumeration ----*/
(function (qrcodegen) {
    var QrCode;
    (function (QrCode) {
        /*
         * The error correction level in a QR Code symbol. Immutable.
         */
        class Ecc {
            /*-- Constructor and fields --*/
            constructor(
            // In the range 0 to 3 (unsigned 2-bit integer).
            ordinal, 
            // (Package-private) In the range 0 to 3 (unsigned 2-bit integer).
            formatBits) {
                this.ordinal = ordinal;
                this.formatBits = formatBits;
            }
        }
        /*-- Constants --*/
        Ecc.LOW = new Ecc(0, 1); // The QR Code can tolerate about  7% erroneous codewords
        Ecc.MEDIUM = new Ecc(1, 0); // The QR Code can tolerate about 15% erroneous codewords
        Ecc.QUARTILE = new Ecc(2, 3); // The QR Code can tolerate about 25% erroneous codewords
        Ecc.HIGH = new Ecc(3, 2); // The QR Code can tolerate about 30% erroneous codewords
        QrCode.Ecc = Ecc;
    })(QrCode = qrcodegen.QrCode || (qrcodegen.QrCode = {}));
})(qrcodegen || (qrcodegen = {}));
/*---- Public helper enumeration ----*/
(function (qrcodegen) {
    var QrSegment;
    (function (QrSegment) {
        /*
         * Describes how a segment's data bits are interpreted. Immutable.
         */
        class Mode {
            /*-- Constructor and fields --*/
            constructor(
            // The mode indicator bits, which is a uint4 value (range 0 to 15).
            modeBits, 
            // Number of character count bits for three different version ranges.
            numBitsCharCount) {
                this.modeBits = modeBits;
                this.numBitsCharCount = numBitsCharCount;
            }
            /*-- Method --*/
            // (Package-private) Returns the bit width of the character count field for a segment in
            // this mode in a QR Code at the given version number. The result is in the range [0, 16].
            numCharCountBits(ver) {
                return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
            }
        }
        /*-- Constants --*/
        Mode.NUMERIC = new Mode(0x1, [10, 12, 14]);
        Mode.ALPHANUMERIC = new Mode(0x2, [9, 11, 13]);
        Mode.BYTE = new Mode(0x4, [8, 16, 16]);
        Mode.KANJI = new Mode(0x8, [8, 10, 12]);
        Mode.ECI = new Mode(0x7, [0, 0, 0]);
        QrSegment.Mode = Mode;
    })(QrSegment = qrcodegen.QrSegment || (qrcodegen.QrSegment = {}));
})(qrcodegen || (qrcodegen = {}));

  // ── 연결 설정: 공개 PeerServer는 연결 정보만 소개하고, 실제 데이터 경로는 LAN 후보만 허용합니다.
  // PeerServer v1 프로토콜 참고: peers/peerjs v1.5.5의 socket.ts와 negotiator.ts.
  const SIGNAL_URL = 'wss://0.peerjs.com/peerjs';
  const ICE_CONFIG = { iceServers: [], iceTransportPolicy: 'all' };
  const SESSION_MS = 10 * 60 * 1000;
  const CONNECT_MS = 25000;
  const CHUNK_SIZE = 16 * 1024;
  const randomBytes = count => crypto.getRandomValues(new Uint8Array(count));
  const hexId = () => Array.from(randomBytes(16), value => value.toString(16).padStart(2, '0')).join('');
  const url64 = bytes => base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

  // ── LAN 후보 검사: STUN/TURN과 공인 주소 후보를 보내지도 받지도 않아 WAN 경로를 만들지 않습니다.
  function isPrivateAddress(address) {
    if (typeof address !== 'string') return false;
    const value = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    if (value.endsWith('.local')) return /^[a-z0-9-]{1,253}\.local$/.test(value);
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
    if (ipv4) {
      const parts = ipv4.slice(1).map(Number);
      if (parts.some(part => part > 255)) return false;
      return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254);
    }
    return /^(?:fc|fd)[0-9a-f]{2}:/i.test(value) || /^fe[89ab][0-9a-f]:/i.test(value);
  }
  function candidateAddress(candidate) {
    if (typeof candidate?.address === 'string') return candidate.address;
    const parts = typeof candidate?.candidate === 'string' ? candidate.candidate.trim().split(/\s+/) : [];
    return parts.length >= 8 ? parts[4] : '';
  }
  function isLanCandidate(candidateInit) {
    try {
      const candidate = candidateInit instanceof RTCIceCandidate ? candidateInit : new RTCIceCandidate(candidateInit);
      const parts = candidate.candidate.trim().split(/\s+/);
      const typeAt = parts.indexOf('typ');
      const type = candidate.type || (typeAt >= 0 ? parts[typeAt + 1] : '');
      return type === 'host' && isPrivateAddress(candidateAddress(candidate));
    } catch { return false; }
  }
  function lanOnlyDescription(description) {
    assert(description && typeof description.type === 'string' && typeof description.sdp === 'string', '잘못된 연결 설명입니다.');
    // 후보는 SDP와 중복시키지 않고 검사된 trickle 메시지로만 보냅니다.
    const lines = description.sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates');
    return { type: description.type, sdp: `${lines.filter(Boolean).join('\r\n')}\r\n` };
  }
  function fromUrl64(text, size) {
    assert(typeof text === 'string' && /^[A-Za-z0-9_-]+$/.test(text), '전송 링크가 올바르지 않습니다.');
    const value = unbase64(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4), size);
    assert(value.length === size, '전송 링크의 키 길이가 올바르지 않습니다.');
    return value;
  }

  // ── 일회용 주소: 비밀 키는 URL fragment에만 넣습니다. 사용자 암호와 외부 QR 서비스를 쓰지 않습니다.
  function invitationURL(invite) {
    return `${ORIGIN}/#csb2=${invite.peer}.${invite.secret}.${invite.expires.toString(36)}`;
  }
  function parseInvitation(text) {
    let url;
    try { url = new URL(text.trim()); } catch { throw new Error('보내는 기기의 전송 링크를 그대로 붙여넣어 주세요.'); }
    assert(url.origin === ORIGIN && url.pathname === '/' && !url.search && !url.username && !url.password, 'Crack 메인페이지의 전송 링크만 사용할 수 있습니다.');
    const match = /^#csb2=(csb-[a-f0-9]{32})\.([A-Za-z0-9_-]{43})\.([a-z0-9]{1,12})$/.exec(url.hash);
    assert(match, '전송 링크가 잘렸거나 형식이 다릅니다.');
    const expires = parseInt(match[3], 36);
    assert(Number.isSafeInteger(expires) && expires > Date.now(), '시간이 지난 링크입니다. 보내는 기기에서 새 링크를 만들어 주세요.');
    assert(expires < Date.now() + SESSION_MS * 2, '링크의 만료 시간이 올바르지 않습니다. 기기의 시간을 확인해 주세요.');
    fromUrl64(match[2], 32);
    return { peer: match[1], secret: match[2], expires };
  }

  // ── 자동 세션 암호: 링크의 무작위 키에서 인증용/본문용 키를 분리합니다. 비밀번호 입력은 없습니다.
  async function sessionKeys(invite) {
    const bytes = fromUrl64(invite.secret, 32);
    try {
      const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
      const params = info => ({ name: 'HKDF', hash: 'SHA-256', salt: textBytes(invite.peer), info: textBytes(`csb2:${info}`) });
      const [encryption, authentication] = await Promise.all([
        crypto.subtle.deriveKey(params('data'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
        crypto.subtle.deriveKey(params('auth'), material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']),
      ]);
      return { encryption, authentication };
    } finally { bytes.fill(0); }
  }
  const proofText = (peer, challenge) => textBytes(`csb2:receive:${peer}:${challenge}`);
  const packetAAD = peer => textBytes(`csb2:data:${peer}`);
  async function encryptDocument(doc, key, peer) {
    validateDocument(doc);
    const plain = textBytes(JSON.stringify(await encodeGraph(doc)));
    try {
      assert(plain.length <= PLAIN_LIMIT, '데이터가 40 MB를 넘습니다. 보내는 항목을 줄여 주세요.');
      const iv = randomBytes(12);
      const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: packetAAD(peer) }, key, plain));
      return { bytes, iv: url64(iv) };
    } finally { plain.fill(0); }
  }
  async function decryptDocument(bytes, iv, key, peer) {
    let plain;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromUrl64(iv, 12), additionalData: packetAAD(peer) }, key, bytes)); }
    catch { throw new Error('전송 데이터를 검증하지 못했습니다. 저장소는 변경하지 않았습니다.'); }
    try {
      const doc = decodeGraph(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
      validateDocument(doc);
      assert(doc.purpose === 'transfer', '공유 데이터만 받을 수 있습니다.');
      return doc;
    } finally { plain.fill(0); }
  }

  // ── 시그널링 연결: 저장 데이터/인증 키를 보내지 않으며, 종료·오류 시 heartbeat도 정리합니다.
  class Signaling {
    constructor(id, onMessage, onFailure, onReconnect = () => {}) {
      this.id = id; this.onMessage = onMessage; this.onFailure = onFailure; this.onReconnect = onReconnect;
      this.closed = false; this.ready = false; this.everOpened = false; this.retries = 0;
      this.pending = 0; this.chain = Promise.resolve(); this.outbox = []; this.token = hexId();
    }
    open() {
      return new Promise((resolve, reject) => {
        this.rejectOpen = reject;
        this.resolveOpen = resolve;
        this.connect();
      });
    }
    connect() {
      if (this.closed) return;
      this.ready = false;
      const query = new URLSearchParams({ key: 'peerjs', id: this.id, token: this.token, version: '1.5.5' });
      const socket = new WebSocket(`${SIGNAL_URL}?${query}`);
      this.socket = socket;
      this.timer = setTimeout(() => {
        if (this.socket === socket) {
          socket.onclose = null;
          try { socket.close(); } catch { /* 이미 닫힌 소켓입니다. */ }
          this.retryOrFail(new Error('연결 서버 응답 시간이 초과되었습니다. Firefox의 추적 방지·DNS/VPN 설정을 확인해 주세요.'));
        }
      }, 15000);
      socket.onmessage = event => {
          if (this.closed || this.socket !== socket) return;
          if (typeof event.data !== 'string' || event.data.length > 160000 || this.pending >= 200) { this.fail(new Error('연결 서버의 응답이 올바르지 않습니다.')); return; }
          let message;
          try { message = JSON.parse(event.data); } catch { this.fail(new Error('연결 서버 응답을 읽지 못했습니다.')); return; }
          if (message.type === 'OPEN' && !this.ready) {
            const reconnected = this.everOpened;
            this.ready = true; this.everOpened = true; this.retries = 0; clearTimeout(this.timer);
            const resolve = this.resolveOpen; this.resolveOpen = null; this.rejectOpen = null;
            clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('{"type":"HEARTBEAT"}'); }, 5000);
            while (this.outbox.length && socket.readyState === WebSocket.OPEN) socket.send(this.outbox.shift());
            resolve?.();
            if (reconnected) Promise.resolve(this.onReconnect()).catch(error => this.fail(error));
            return;
          }
          if (message.type === 'ID-TAKEN' && this.everOpened) {
            socket.onclose = null; try { socket.close(); } catch { /* 이미 닫힌 소켓입니다. */ }
            this.retryOrFail(new Error('연결 ID가 아직 서버에서 정리되지 않았습니다.')); return;
          }
          if (['ERROR', 'ID-TAKEN', 'INVALID-KEY'].includes(message.type)) { this.fail(new Error('연결 서버를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.')); return; }
          this.pending++;
          this.chain = this.chain.then(async () => { if (!this.closed) await this.onMessage(message); })
            .catch(error => this.fail(error)).finally(() => { this.pending--; });
        };
      socket.onerror = () => { /* Firefox는 상세 원인을 숨기므로 close의 코드와 재접속 결과로 판단합니다. */ };
      socket.onclose = event => {
        if (this.closed || this.socket !== socket) return;
        clearTimeout(this.timer); clearInterval(this.heartbeat); this.ready = false;
        this.retryOrFail(new Error(`연결 서버 접속이 종료되었습니다 (코드 ${event.code || '없음'}${event.reason ? `: ${event.reason}` : ''}).`));
      };
    }
    retryOrFail(error) {
      if (this.closed) return;
      if (this.retries < 3) {
        const delay = [500, 1200, 2500][this.retries++];
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), delay);
        return;
      }
      this.fail(new Error(`${error.message} 3회 재접속에도 실패했습니다. Firefox에서 https://0.peerjs.com 접속과 보호 설정을 확인해 주세요.`));
    }
    send(type, dst, payload) {
      assert(!this.closed, '연결 서버가 닫혔습니다.');
      const message = JSON.stringify({ type, dst, payload });
      if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
      else {
        assert(this.everOpened && this.outbox.length < 256, '연결 서버가 아직 준비되지 않았습니다.');
        this.outbox.push(message);
      }
    }
    fail(error) {
      if (this.closed) return;
      const reject = this.rejectOpen; this.rejectOpen = this.resolveOpen = null;
      this.close(); reject?.(error); this.onFailure(error);
    }
    close() {
      if (this.closed) return;
      this.closed = true; this.ready = false; clearTimeout(this.timer); clearTimeout(this.retryTimer); clearInterval(this.heartbeat);
      const reject = this.rejectOpen; this.rejectOpen = this.resolveOpen = null; reject?.(new Error('연결을 취소했습니다.'));
      this.outbox.length = 0;
      if (this.socket) {
        this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
        this.socket.close(); this.socket = null;
      }
    }
  }

  // ── 데이터 채널: 16 KB 조각과 송신 버퍼 제어로 모바일의 메시지 크기/메모리 차이를 줄입니다.
  class PeerPipe {
    constructor(signaling, remote, id, onData, onClose) {
      this.signaling = signaling; this.remote = remote; this.id = id; this.onData = onData; this.onClose = onClose;
      this.closed = false; this.chain = Promise.resolve(); this.pending = 0; this.candidates = 0;
      this.pendingCandidates = []; this.localCandidates = []; this.descriptionSent = false;
      this.pc = new RTCPeerConnection(ICE_CONFIG);
      this.pc.onicecandidate = event => {
        if (event.candidate && !this.closed && !signaling.closed && isLanCandidate(event.candidate)) {
          try {
            const candidate = event.candidate.toJSON();
            this.localCandidates.push(candidate);
            if (this.descriptionSent) this.sendCandidate(candidate);
          }
          catch (error) { this.close(error); }
        }
      };
      this.pc.onconnectionstatechange = () => { if (this.pc.connectionState === 'failed') this.close(new Error('기기끼리 연결되지 않습니다. 같은 Wi-Fi에서 다시 시도해 주세요.')); };
      this.pc.ondatachannel = event => this.attach(event.channel);
      this.touch(CONNECT_MS);
    }
    touch(ms = 30000) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.close(new Error('전송 응답이 없습니다. 같은 Wi-Fi인지 확인하고 새 링크로 다시 시도해 주세요.')), ms);
    }
    attach(channel) {
      if (this.channel || this.closed) { channel.close(); return; }
      this.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 65536;
      channel.onopen = async () => {
        try {
          await this.verifyLanPath();
          if (this.closed) return;
          this.touch(); this.onOpen?.();
        } catch (error) { this.close(error); }
      };
      channel.onmessage = event => {
        if (this.closed || this.pending >= 256) { this.close(new Error('전송 메시지가 너무 빠르거나 잘못되었습니다.')); return; }
        const raw = event.data;
        if (!((typeof raw === 'string' && raw.length <= 4096) || (raw instanceof ArrayBuffer && raw.byteLength <= CHUNK_SIZE))) {
          this.close(new Error('지원하지 않는 전송 메시지입니다.')); return;
        }
        this.touch(); this.pending++;
        this.chain = this.chain.then(async () => {
          if (!this.closed) await this.onData(typeof raw === 'string' ? JSON.parse(raw) : raw);
        }).catch(error => this.close(error)).finally(() => { this.pending--; });
      };
      channel.onerror = () => this.close(new Error('데이터 연결 오류입니다. 새 링크로 다시 시도해 주세요.'));
      channel.onclose = () => this.close(new Error('보내는 기기가 전송을 종료했거나 연결이 끊어졌습니다.'));
    }
    async offer() {
      this.attach(this.pc.createDataChannel('csb2', { ordered: true }));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      assert(!this.closed, '연결이 취소되었습니다.');
      this.resignalOffer();
    }
    async answer(sdp) {
      assert(sdp?.type === 'offer' && typeof sdp.sdp === 'string', '잘못된 연결 요청입니다.');
      await this.pc.setRemoteDescription(lanOnlyDescription(sdp));
      await this.flushCandidates();
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      assert(!this.closed, '연결이 취소되었습니다.');
      this.resignalAnswer();
    }
    async signal(message) {
      if (this.closed) return;
      if (message.type === 'ANSWER') {
        assert(message.payload.sdp?.type === 'answer', '잘못된 연결 응답입니다.');
        await this.pc.setRemoteDescription(lanOnlyDescription(message.payload.sdp));
        await this.flushCandidates();
      } else if (message.type === 'CANDIDATE') {
        assert(++this.candidates <= 128, '연결 후보가 너무 많습니다.');
        assert(isLanCandidate(message.payload.candidate), 'LAN 밖의 연결 후보를 거부했습니다.');
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.payload.candidate);
        else this.pendingCandidates.push(message.payload.candidate);
      }
    }
    async flushCandidates() {
      while (this.pendingCandidates.length) await this.pc.addIceCandidate(this.pendingCandidates.shift());
    }
    resignalOffer() {
      if (!this.closed && this.pc.localDescription?.type === 'offer') {
        this.signaling.send('OFFER', this.remote,
          { type: 'data', connectionId: this.id, sdp: lanOnlyDescription(this.pc.localDescription), label: 'csb2', serialization: 'raw', reliable: true });
        this.descriptionSent = true;
        for (const candidate of this.localCandidates) this.sendCandidate(candidate);
      }
    }
    resignalAnswer() {
      if (!this.closed && this.pc.localDescription?.type === 'answer') {
        this.signaling.send('ANSWER', this.remote,
          { type: 'data', connectionId: this.id, sdp: lanOnlyDescription(this.pc.localDescription) });
        this.descriptionSent = true;
        for (const candidate of this.localCandidates) this.sendCandidate(candidate);
      }
    }
    sendCandidate(candidate) {
      this.signaling.send('CANDIDATE', this.remote, { type: 'data', connectionId: this.id, candidate });
    }
    async verifyLanPath() {
      for (let attempt = 0; attempt < 5; attempt++) {
        const stats = await this.pc.getStats();
        let pair;
        for (const report of stats.values()) {
          if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
          if (!pair && report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) pair = report;
        }
        if (pair) {
          const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
          const localAddress = local?.address || local?.ip;
          const remoteAddress = remote?.address || remote?.ip;
          // 후보 통계가 제공되면 실제 선택 경로도 재검사합니다. 일부 Safari는 주소 필드를 생략합니다.
          if (local?.candidateType && remote?.candidateType && localAddress && remoteAddress) {
            assert(local.candidateType === 'host' && remote.candidateType === 'host' &&
              isPrivateAddress(localAddress) && isPrivateAddress(remoteAddress), 'LAN 밖의 연결 경로를 차단했습니다. 두 기기를 같은 공유기에 연결해 주세요.');
          }
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // 채널에 들어갈 수 있는 양쪽 후보는 이미 사설 host로 제한되었습니다.
      assert(this.localCandidates.length && this.candidates, 'LAN 연결 후보를 확인하지 못했습니다. 공유기의 기기 격리 설정을 확인해 주세요.');
    }
    send(message) {
      assert(!this.closed && this.channel?.readyState === 'open', '전송 연결이 닫혔습니다.');
      this.channel.send(typeof message === 'object' && !(message instanceof Uint8Array) ? JSON.stringify(message) : message);
    }
    async sendBytes(bytes, progress) {
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        await this.drain();
        this.send(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_SIZE)));
        this.touch(); progress(Math.min(1, (offset + CHUNK_SIZE) / bytes.length));
      }
    }
    drain() {
      assert(!this.closed, '전송이 종료되었습니다.');
      if (this.channel.bufferedAmount < 262144) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const channel = this.channel;
        const cleanup = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', ready); channel.removeEventListener('close', failed); };
        const ready = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('전송 연결이 닫혔습니다.')); };
        const timer = setTimeout(failed, 30000);
        channel.addEventListener('bufferedamountlow', ready, { once: true }); channel.addEventListener('close', failed, { once: true });
      });
    }
    close(error = null) {
      if (this.closed) return;
      this.closed = true; clearTimeout(this.timer);
      this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ondatachannel = null;
      if (this.channel) { this.channel.onopen = this.channel.onmessage = this.channel.onclose = this.channel.onerror = null; this.channel.close(); }
      this.pc.close(); this.onClose(error);
    }
  }

  // ── 보내기 세션: 첫 인증 기기 한 대에만 전송합니다. 한 번 사용/10분 만료/닫기에 재접속 경로를 없앱니다.
  class ShareSender {
    constructor(callbacks = {}) {
      this.callbacks = callbacks; this.closed = false; this.claimed = null; this.peers = new Map();
      this.invite = { peer: `csb-${hexId()}`, secret: url64(randomBytes(32)), expires: Date.now() + SESSION_MS };
    }
    async start(doc) {
      try {
        assert(typeof RTCPeerConnection === 'function' && crypto.subtle, '이 브라우저는 직접 전송을 지원하지 않습니다.');
        const keys = await sessionKeys(this.invite);
        if (this.closed) return null;
        this.keys = keys;
        const packet = await encryptDocument(doc, keys.encryption, this.invite.peer);
        if (this.closed) { packet.bytes.fill(0); return null; }
        this.packet = packet;
        this.signalLink = new Signaling(this.invite.peer, message => this.message(message), error => this.close('error', error),
          () => { for (const pipe of this.peers.values()) pipe.resignalAnswer(); });
        await this.signalLink.open();
        if (this.closed) return null;
        this.invite.expires = Date.now() + SESSION_MS;
        this.timer = setTimeout(() => this.close('expired'), SESSION_MS);
        this.callbacks.state?.('waiting');
        return invitationURL(this.invite);
      } catch (error) { if (!this.closed) this.close('error', error); throw error; }
    }
    async message(message) {
      if (this.closed || this.claimed) return;
      const { src, payload } = message;
      if (typeof src !== 'string' || !payload || typeof payload.connectionId !== 'string') return;
      const key = `${src}:${payload.connectionId}`;
      if (message.type === 'OFFER') {
        if (this.peers.has(key)) { this.peers.get(key).resignalAnswer(); return; }
        if (this.peers.size >= 4 || payload.type !== 'data' || payload.label !== 'csb2') return;
        const pipe = new PeerPipe(this.signalLink, src, payload.connectionId, data => this.receive(pipe, data), error => {
          this.peers.delete(key);
          if (!this.closed && this.claimed === pipe) this.close('error', error || new Error('전송 연결이 종료되었습니다.'));
        });
        pipe.challenge = url64(randomBytes(24));
        pipe.onOpen = () => pipe.send({ t: 'challenge', challenge: pipe.challenge });
        this.peers.set(key, pipe);
        try { await pipe.answer(payload.sdp); } catch (error) { pipe.close(error); }
      } else { await this.peers.get(key)?.signal(message); }
    }
    async receive(pipe, data) {
      assert(!this.closed && isPlain(data), '전송이 종료되었거나 요청이 잘못되었습니다.');
      if (!pipe.authorized) {
        assert(data.t === 'auth', '잘못된 연결 인증입니다.');
        const proof = fromUrl64(data.proof, 32);
        const valid = await crypto.subtle.verify('HMAC', this.keys.authentication, proof, proofText(this.invite.peer, pipe.challenge));
        assert(valid && !this.closed && !this.claimed && Date.now() < this.invite.expires, '사용할 수 없는 전송 링크입니다.');
        // await 직후 하나만 선점하여 동시에 인증한 두 번째 기기로 데이터가 나가지 않게 합니다.
        this.claimed = pipe; pipe.authorized = true;
        this.signalLink.close();
        for (const other of Array.from(this.peers.values())) if (other !== pipe) other.close();
        this.callbacks.state?.('sending');
        pipe.send({ t: 'begin', size: this.packet.bytes.length, iv: this.packet.iv });
        await pipe.sendBytes(this.packet.bytes, value => this.callbacks.progress?.(value));
        pipe.send({ t: 'end' });
      } else {
        assert(data.t === 'received', '잘못된 수신 확인입니다.');
        this.close('done');
      }
    }
    close(reason = 'closed', error = null) {
      if (this.closed) return;
      this.closed = true; clearTimeout(this.timer); this.signalLink?.close();
      for (const pipe of Array.from(this.peers.values())) pipe.close();
      this.peers.clear(); this.packet?.bytes.fill(0); this.packet = null; this.keys = null;
      this.invite.secret = ''; this.claimed = null;
      this.callbacks.state?.(reason, error);
    }
  }

  // ── 받기 세션: 완전한 수신·인증·구조 검사 뒤에만 데이터를 UI에 넘깁니다. 여기서는 저장하지 않습니다.
  class ShareReceiver {
    constructor(callbacks = {}) { this.callbacks = callbacks; this.closed = false; this.delivered = false; }
    async start(text) {
      try {
        this.invite = parseInvitation(text);
        assert(typeof RTCPeerConnection === 'function' && crypto.subtle, '이 브라우저는 직접 전송을 지원하지 않습니다.');
        const keys = await sessionKeys(this.invite);
        if (this.closed) return;
        this.keys = keys;
        this.signalLink = new Signaling(`csb-${hexId()}`, message => this.message(message), error => this.close(error),
          () => this.pipe?.resignalOffer());
        await this.signalLink.open();
        if (this.closed) return;
        this.pipe = new PeerPipe(this.signalLink, this.invite.peer, `dc-${hexId()}`, data => this.receive(data), error => { if (!this.closed) this.close(error); });
        this.timer = setTimeout(() => this.close(new Error('전송 링크가 만료되었습니다.')), Math.max(1, this.invite.expires - Date.now()));
        await this.pipe.offer();
      } catch (error) { this.close(error); throw error; }
    }
    async message(message) {
      if (this.closed) return;
      if (message.type === 'EXPIRE') { this.close(new Error('종료되었거나 이미 사용한 링크입니다. 보내는 기기에서 새 링크를 만들어 주세요.')); return; }
      if (message.src === this.invite.peer && message.payload?.connectionId === this.pipe?.id) await this.pipe.signal(message);
    }
    async receive(data) {
      if (this.closed) return;
      if (data instanceof ArrayBuffer) {
        assert(this.buffer && !this.verifying && this.offset + data.byteLength <= this.buffer.length, '전송 데이터 길이가 올바르지 않습니다.');
        this.buffer.set(new Uint8Array(data), this.offset); this.offset += data.byteLength;
        this.callbacks.progress?.(this.offset / this.buffer.length); return;
      }
      assert(isPlain(data), '잘못된 전송 메시지입니다.');
      if (data.t === 'challenge') {
        assert(!this.authenticated && typeof data.challenge === 'string', '중복된 연결 인증입니다.');
        fromUrl64(data.challenge, 24); this.authenticated = true;
        const proof = await crypto.subtle.sign('HMAC', this.keys.authentication, proofText(this.invite.peer, data.challenge));
        if (!this.closed) this.pipe.send({ t: 'auth', proof: url64(new Uint8Array(proof)) });
      } else if (data.t === 'begin') {
        assert(this.authenticated && !this.buffer && Number.isInteger(data.size) && data.size >= 16 && data.size <= PLAIN_LIMIT + 16, '잘못된 전송 크기입니다.');
        fromUrl64(data.iv, 12); this.iv = data.iv; this.offset = 0; this.buffer = new Uint8Array(data.size);
      } else if (data.t === 'end') {
        assert(this.buffer && this.offset === this.buffer.length && !this.verifying, '데이터를 끝까지 받지 못했습니다.');
        this.verifying = true;
        const doc = await decryptDocument(this.buffer, this.iv, this.keys.encryption, this.invite.peer);
        if (this.closed) return;
        this.delivered = true;
        this.pipe.send({ t: 'received' });
        this.signalLink.close(); this.buffer.fill(0); this.buffer = null;
        this.callbacks.data?.(doc);
        this.finishTimer = setTimeout(() => this.close(), 1000);
      } else throw new Error('알 수 없는 전송 메시지입니다.');
    }
    close(error = null) {
      if (this.closed) return;
      this.closed = true; clearTimeout(this.timer); clearTimeout(this.finishTimer);
      this.signalLink?.close(); this.pipe?.close(); this.buffer?.fill(0); this.buffer = null; this.keys = null;
      if (this.invite) this.invite.secret = '';
      if (!this.delivered && error) this.callbacks.error?.(error);
    }
  }

  // ── 화면 헬퍼: 데이터는 텍스트로만 표시합니다. HTML·스크립트처럼 보이는 값도 실행하지 않습니다.
  function element(tag, text = '', attrs = {}) {
    const node = document.createElement(tag); node.textContent = text;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }
  function button(text, callback, className = '') {
    const node = element('button', text, { type: 'button', class: className });
    node.addEventListener('click', callback); return node;
  }
  const itemId = item => JSON.stringify([item.kind, item.name]);
  const mainPage = () => location.origin === ORIGIN && location.pathname === '/';
  function guessedOwner(name) {
    if (/^lore[-_]/i.test(name)) return 'lore 계열 · 이름으로 추정';
    if (/^csp_scene_painter(?:[_-]|$)/i.test(name)) return 'csp_scene_painter 계열 · 이름으로 추정';
    return '저장한 스크립트 확인 불가';
  }
  function itemsFromDocument(doc) {
    return [
      ...doc.local.map(value => ({ kind: 'local', name: value.key, value: value.value })),
      ...doc.databases.map(value => ({ kind: 'db', name: value.name, db: value })),
    ];
  }
  function selectedDocument(doc, selection) {
    return { ...doc, local: doc.local.filter(item => selection.has(JSON.stringify(['local', item.key]))),
      databases: doc.databases.filter(item => selection.has(JSON.stringify(['db', item.name]))) };
  }
  async function catalog() {
    const items = [], issues = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i); if (name !== null) items.push({ kind: 'local', name });
      }
    } catch { issues.push('이 브라우저에서 Local Storage를 읽을 수 없습니다.'); }
    if (typeof indexedDB.databases !== 'function') issues.push('이 브라우저는 DB 자동 목록을 지원하지 않습니다. 브라우저를 업데이트해 주세요.');
    else {
      try {
        for (const info of await indexedDB.databases()) {
          if (typeof info.name !== 'string') continue;
          try { const db = await readDatabase(info.name, true); if (db) items.push({ kind: 'db', name: info.name, db }); }
          catch { issues.push(`읽을 수 없는 DB: ${info.name}`); }
        }
      } catch { issues.push('DB 목록을 읽지 못했습니다. 다른 탭을 닫고 다시 시도해 주세요.'); }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, issues };
  }

  // ── 상세보기: 작성자는 단정하지 않고 구조와 제한된 실제 값만 보여 줍니다.
  function previewText(value) {
    let budget = 300;
    const seen = new WeakSet();
    function visit(current, depth) {
      if (--budget < 0) return '[이하 생략]';
      if (typeof current === 'string') return current.length > 1200 ? `${current.slice(0, 1200)}… [생략]` : current;
      if (typeof current === 'bigint') return `${current}n`;
      if (current === undefined) return '[undefined]';
      if (typeof current === 'number' && !Number.isFinite(current)) return String(current);
      if (!isObject(current)) return current;
      if (seen.has(current)) return '[순환/공유 참조]';
      seen.add(current);
      const type = Object.prototype.toString.call(current).slice(8, -1);
      if (type === 'Date') return Number.isNaN(current.getTime()) ? '[Invalid Date]' : current.toISOString();
      if (type === 'Blob' || type === 'File') return `[${type}: ${sizeText(current.size)}, ${current.type || '유형 없음'}]`;
      if (type === 'ArrayBuffer' || ArrayBuffer.isView(current)) return `[${type}: ${sizeText(current.byteLength)}]`;
      if (depth >= 5) return `[${type}: 깊이 제한]`;
      if (current instanceof Map) return { Map: Array.from(current).slice(0, 20).map(([key, item]) => [visit(key, depth + 1), visit(item, depth + 1)]) };
      if (current instanceof Set) return { Set: Array.from(current).slice(0, 20).map(item => visit(item, depth + 1)) };
      if (type === 'RegExp') return String(current);
      if (Array.isArray(current)) return current.slice(0, 20).map(item => visit(item, depth + 1));
      const result = Object.create(null);
      const keys = Object.keys(current);
      for (const key of keys.slice(0, 20)) result[key] = visit(current[key], depth + 1);
      if (keys.length > 20) result['…'] = `${keys.length - 20}개 속성 생략`;
      return result;
    }
    return JSON.stringify(visit(value, 0), null, 2).slice(0, 20000);
  }
  function qrImage(text) {
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    const canvas = element('canvas', '', { 'aria-label': '전송 링크 QR 코드', role: 'img', class: 'qr' });
    const scale = 5, border = 4;
    canvas.width = canvas.height = (qr.size + border * 2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#111827';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
    return canvas;
  }

  // ── 단순한 팝업: 첫 화면은 두 가지 행동만, 주의문구는 링크 화면과 저장 직전에 배치합니다.
  const CSS = `
    :host { all: initial; color: #172033; font: 14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    :host([hidden]) { display: none !important; }
    * { box-sizing: border-box; } [hidden] { display: none !important; }
    button,input,textarea { font: inherit; } button { cursor: pointer; color: inherit; border: 0; }
    button:disabled { opacity: .45; cursor: default; } button:focus-visible,input:focus-visible,textarea:focus-visible { outline: 3px solid #9bbafb; outline-offset: 2px; }
    .launcher { position: fixed; right: 18px; bottom: max(18px,env(safe-area-inset-bottom)); z-index: 2147483646; background: #285ed7; color: white; border-radius: 999px; padding: 12px 18px; box-shadow: 0 4px 20px #16377433; font-weight: 700; }
    .overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: #101a3390; }
    .panel { display: flex; flex-direction: column; background: #fff; width: min(480px,100%); max-height: 90vh; max-height: 90dvh; border-radius: 22px; box-shadow: 0 20px 80px #09172f40; overflow: hidden; }
    .header { display: flex; align-items: center; gap: 8px; padding: 18px 20px 8px; flex-shrink: 0; }
    h2 { font-size: 20px; font-weight: 750; letter-spacing: -.5px; margin: 0; flex: 1; } h3 { font-size: 17px; margin: 8px 0; } p { margin: 8px 0; }
    .icon { width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0; background: transparent; font-size: 22px; color: #62718b; }
    .icon:hover { background: #f0f4fa; } .back { margin-left: -10px; }
    .content { overflow-y: auto; padding: 4px 24px 18px; min-height: 0; overscroll-behavior: contain; }
    .subtitle,.muted { color: #68778d; } .subtitle { margin: 0 0 20px; } .tiny { font-size: 12px; }
    .footer { padding: 14px 24px 22px; border-top: 1px solid #edf0f5; background: #fff; flex-shrink: 0; }
    .primary,.secondary { display: block; width: 100%; padding: 13px 16px; min-height: 46px; border-radius: 12px; font-weight: 700; font-size: 15px; }
    .primary { background: #285ed7; color: #fff; } .primary:hover { background: #1e50bd; }
    .secondary { background: #eef3fc; color: #315594; margin-top: 8px; }
    .choice { display: flex; align-items: center; gap: 16px; width: 100%; text-align: left; padding: 20px; margin: 12px 0; border: 1px solid #e0e7f1; background: #fff; border-radius: 16px; }
    .choice:hover { border-color: #92b1ee; background: #f8faff; } .choice strong { display: block; font-size: 18px; margin-bottom: 3px; } .choice small { display: block; color: #718097; } .choice .symbol { font-size: 28px; width: 44px; height: 48px; display: grid; place-items: center; border-radius: 12px; color: #285ed7; background: #edf3ff; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin: 12px 0 8px; gap: 8px; color: #68778d; font-size: 13px; } .text-button { background: none; color: #285ed7; padding: 5px; }
    .list { border: 1px solid #e3e9f2; border-radius: 12px; overflow: hidden; } .item { display: flex; align-items: center; border-bottom: 1px solid #e9edf4; padding: 9px 7px 9px 12px; } .item:last-child { border-bottom: 0; }
    .item label { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; cursor: pointer; padding: 5px 0; } .item input { width: 18px; height: 18px; accent-color: #285ed7; flex-shrink: 0; } .item .names { min-width: 0; } .item strong { display: block; overflow-wrap: anywhere; font-size: 14px; } .item small { display: block; color: #79879a; font-size: 11px; }
    input[type=search],textarea { width: 100%; padding: 12px; border: 1px solid #dce3ee; border-radius: 12px; color: #23344e; background: #f8faff; font-size: 16px; resize: vertical; } textarea.link { font-size: 12px; min-height: 70px; word-break: break-all; }
    .notice { background: #f6f8fc; color: #68768c; font-size: 12px; line-height: 1.7; padding: 12px 14px; border-radius: 12px; margin: 16px 0 0; }
    .status { margin: 10px 0 0; color: #68768c; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; } .error { color: #ac3a42; } .center { text-align: center; } .big-icon { font-size: 38px; color: #285ed7; margin: 10px 0; }
    .qr { display: block; width: 190px; max-width: 100%; height: auto; margin: 10px auto; image-rendering: pixelated; } .pill { display: inline-block; background: #ecf5ed; color: #337843; padding: 4px 10px; border-radius: 999px; font-size: 12px; }
    progress { width: 100%; height: 8px; accent-color: #285ed7; } pre { background: #f6f8fc; border: 1px solid #e4eaf2; border-radius: 10px; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 ui-monospace,monospace; max-height: 330px; overflow: auto; }
    @media(max-width:480px) { .overlay { padding: 10px; } .panel { border-radius: 18px; max-height: 92dvh; } .content { padding: 2px 18px 16px; } .header { padding: 12px 14px 5px; } .footer { padding: 12px 18px 18px; } .qr { width: 190px; } }
  `;

  function boot() {
    if (!mainPage() || window.top !== window.self) return;
    // 페이지에 링크 키를 오래 남기지 않습니다. 사용자 스크립트의 주입 시점 전 노출까지 막지는 못합니다.
    let initialLink = location.hash.startsWith('#csb2=') ? location.href : '';
    if (initialLink) history.replaceState(history.state, '', location.pathname + location.search);
    const ready = () => {
      if (!mainPage()) return;
      const host = element('div');
      const shadow = host.attachShadow({ mode: 'closed' }); shadow.append(element('style', CSS));
      const launch = button('저장소 공유', () => openPanel(), 'launcher'); shadow.append(launch);
      document.documentElement.append(host);
      let active = null;
      if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Crack 저장소 공유', () => { if (mainPage()) openPanel(); });
      function routeChanged() {
        host.hidden = !mainPage();
        if (!mainPage() && active) active.stopForRoute();
      }
      // SPA 주소 변경도 감지하여 채팅 화면에서는 UI를 숨기고 전송 연결을 종료합니다.
      const routeTimer = setInterval(routeChanged, 250);
      window.addEventListener('popstate', routeChanged);
      const routeObserver = new MutationObserver(routeChanged);
      routeObserver.observe(document.documentElement, { childList: true });
      window.addEventListener('pagehide', event => {
        active?.dispose(true);
        // 뒤로 가기 캐시에서는 타이머/감시자가 브라우저와 함께 정지·재개되어야 합니다.
        if (!event.persisted) { clearInterval(routeTimer); routeObserver.disconnect(); window.removeEventListener('popstate', routeChanged); }
      });
      if (initialLink) { openPanel(initialLink); initialLink = ''; }

      function openPanel(prefill = '') {
        if (!mainPage() || active) return;
        let disposed = false, epoch = 0, busy = false, writing = false;
        let session = null, incoming = null, backup = null, restoreTarget = null;
        let listItems = [], selection = new Set(), filter = '';
        const overlay = element('div', '', { class: 'overlay' });
        const panel = element('section', '', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '저장소 공유', tabindex: '-1' });
        const header = element('div', '', { class: 'header' });
        const back = button('‹', () => {}, 'icon back'); back.setAttribute('aria-label', '뒤로');
        const title = element('h2', '저장소 공유');
        const close = button('×', () => dispose(), 'icon'); close.setAttribute('aria-label', '닫기');
        header.append(back, title, close);
        const content = element('div', '', { class: 'content' });
        const footer = element('div', '', { class: 'footer' });
        const status = element('p', '', { class: 'status', role: 'status', 'aria-live': 'polite' });
        panel.append(header, content, footer); overlay.append(panel); shadow.append(overlay); launch.hidden = true;
        active = { dispose, stopForRoute: () => { session?.close(); if (!writing) dispose(); } };
        panel.addEventListener('keydown', keydown);
        const unload = event => { if (writing) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', unload);
        prefill ? receivePage(prefill, true) : home(); panel.focus();

        // 화면 전환과 비동기 작업의 세대 번호를 관리해 닫은 뒤 완료되는 작업이 팝업을 되살리지 않게 합니다.
        function alive(version) { return !disposed && version === epoch && mainPage(); }
        function view(heading, subtitle = '', onBack = home) {
          epoch++; title.textContent = heading; content.replaceChildren(); footer.replaceChildren();
          status.textContent = ''; status.className = 'status';
          back.hidden = !onBack; back.onclick = () => { if (!busy && !writing) onBack?.(); };
          if (subtitle) content.append(element('p', subtitle, { class: 'subtitle' }));
          content.scrollTop = 0;
        }
        function say(text, error = false) { if (disposed) return; status.textContent = text; status.className = `status${error ? ' error' : ''}`; if (!status.isConnected) content.append(status); }
        function cta(text, task, secondary = false) {
          const node = button(text, () => perform(task), secondary ? 'secondary' : 'primary'); footer.append(node); return node;
        }
        async function perform(task) {
          if (busy || disposed) return;
          busy = true;
          const disabled = Array.from(panel.querySelectorAll('button,input,textarea')).map(node => [node, node.disabled]);
          for (const [node] of disabled) if (node !== close) node.disabled = true;
          try { await task(); } catch (error) { if (!disposed) say(errorText(error), true); }
          finally { busy = false; for (const [node, previous] of disabled) if (node.isConnected) node.disabled = previous; close.disabled = writing; }
        }
        function stopSession() { session?.close(); session = null; }
        function dispose(force = false) {
          if (disposed || (writing && !force)) return;
          disposed = true; epoch++; stopSession(); incoming = backup = restoreTarget = null; listItems = []; selection.clear();
          window.removeEventListener('beforeunload', unload); panel.removeEventListener('keydown', keydown);
          overlay.remove(); active = null; launch.hidden = false; if (mainPage()) launch.focus();
        }
        function keydown(event) {
          if (event.key === 'Escape') { event.preventDefault(); dispose(); return; }
          if (event.key !== 'Tab') return;
          const nodes = Array.from(panel.querySelectorAll('button,input,textarea')).filter(node => !node.disabled && node.getClientRects().length);
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (event.shiftKey && (shadow.activeElement === first || shadow.activeElement === panel)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        function home() {
          if (writing) return;
          stopSession(); incoming = null; listItems = []; selection.clear(); filter = '';
          view('저장소 공유', '다른 기기로 옮기거나, 이 기기로 받아오세요.', null);
          for (const [label, detail, symbol, task] of [
            ['보내기', '이 기기의 데이터로 전송 링크 만들기', '↗', sendPage],
            ['받기', '다른 기기의 전송 링크로 가져오기', '↙', () => receivePage()],
          ]) {
            const card = button('', () => perform(task), 'choice');
            const words = element('span'); words.append(element('strong', label), element('small', detail));
            card.append(element('span', symbol, { class: 'symbol', 'aria-hidden': 'true' }), words); content.append(card);
          }
          if (backup) cta('직전 저장 되돌리기', undo, true);
          footer.hidden = !backup;
        }

        // 보내기 목록은 자동 조회합니다. 별도 DB 이름 검색·추가 단계는 없습니다.
        async function sendPage() {
          stopSession(); footer.hidden = false; view('무엇을 보낼까요?', '옮길 항목을 선택해 주세요.');
          say('데이터 목록을 읽고 있어요…'); const version = epoch;
          const result = await catalog(); if (!alive(version)) return;
          listItems = result.items; selection.clear(); filter = '';
          sendList(); if (result.issues.length) say(result.issues.join('\n'), true);
        }
        function sendList() {
          view('무엇을 보낼까요?', '옮길 항목을 선택해 주세요.'); footer.hidden = false;
          renderList(false, () => sendList());
          const next = cta(`전송 링크 만들기${selection.size ? ` · ${selection.size}개` : ''}`, makeLink);
          next.disabled = selection.size === 0;
          if (!listItems.length) cta('다시 읽기', sendPage, true);
        }
        function renderList(received, redraw) {
          if (listItems.length > 8 || filter) {
            const search = element('input', '', { type: 'search', placeholder: '이름으로 찾기', 'aria-label': '목록 필터' });
            search.value = filter;
            search.addEventListener('input', () => { filter = search.value; redraw(); const next = content.querySelector('input[type=search]'); next?.focus(); });
            content.append(search);
          }
          const terms = filter.toLowerCase().split(/[,|]/).map(value => value.trim()).filter(Boolean);
          const visible = listItems.filter(item => !terms.length || terms.some(term => item.name.toLowerCase().includes(term)));
          const hiddenSelected = listItems.filter(item => selection.has(itemId(item)) && !visible.includes(item)).length;
          const toolbar = element('div', '', { class: 'toolbar' });
          toolbar.append(element('span', `${selection.size}개 선택${hiddenSelected ? ` · 숨겨진 ${hiddenSelected}개 포함` : ''}`));
          const allSelected = visible.length > 0 && visible.every(item => selection.has(itemId(item)));
          toolbar.append(button(allSelected ? '선택 해제' : '전체 선택', () => {
            if (busy) return;
            for (const item of visible) allSelected ? selection.delete(itemId(item)) : selection.add(itemId(item)); redraw();
          }, 'text-button')); content.append(toolbar);
          const list = element('div', '', { class: 'list' });
          if (!visible.length) list.append(element('p', '표시할 데이터가 없어요.', { class: 'muted center' }));
          for (const item of visible) {
            const row = element('div', '', { class: 'item' }), label = element('label');
            const input = element('input', '', { type: 'checkbox', 'aria-label': `${item.kind === 'db' ? 'DB' : '설정'} ${item.name}` });
            input.checked = selection.has(itemId(item));
            input.addEventListener('change', () => { if (busy) return; input.checked ? selection.add(itemId(item)) : selection.delete(itemId(item)); redraw(); });
            const names = element('span', '', { class: 'names' });
            names.append(element('strong', item.name), element('small', `${item.kind === 'db' ? 'DB 전체' : '설정 키'} · ${guessedOwner(item.name)}`));
            label.append(input, names);
            const info = button('ⓘ', () => perform(() => detailPage(item, received, redraw)), 'icon'); info.setAttribute('aria-label', `${item.name} 상세보기`);
            row.append(label, info); list.append(row);
          }
          content.append(list);
        }
        async function detailPage(item, received, returnToList) {
          view('데이터 상세', item.name, returnToList); footer.hidden = false;
          const version = epoch;
          let preview;
          if (item.kind === 'local') {
            const value = received ? item.value : localStorage.getItem(item.name);
            let parsed = value;
            if (typeof value === 'string' && value.length < 200000) { try { parsed = JSON.parse(value); } catch { /* 일반 문자열은 그대로 표시합니다. */ } }
            preview = `Local Storage · ${sizeText(textBytes(value ?? '').length)}\n\n${previewText(parsed)}`;
          } else {
            say('DB 내용을 읽고 있어요…');
            const db = received ? item.db : await readDatabase(item.name, false, 5);
            if (!alive(version)) return;
            assert(db, '이 데이터가 더 이상 존재하지 않습니다.');
            preview = previewText({ name: db.name, version: db.version, stores: db.stores.map(store => ({
              name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
              indexes: store.indexes, sampleRecords: store.records.slice(0, 5),
            })) });
          }
          if (!alive(version)) return;
          status.textContent = ''; content.append(element('p', guessedOwner(item.name), { class: 'muted tiny' }),
            element('pre', preview), element('p', '저장소에는 작성자 정보가 없습니다. 이름 추정은 확정 정보가 아니며, 긴 값은 일부만 표시합니다. DB는 보관함마다 최대 5건의 샘플입니다.', { class: 'muted tiny' }));
          cta('목록으로', returnToList);
        }

        // 링크 화면에서만 전송 주의사항을 보여 줍니다. QR은 이 브라우저 안에서 그립니다.
        async function makeLink() {
          assert(selection.size > 0, '보낼 항목을 선택해 주세요.');
          view('전송 링크 만드는 중', '선택한 데이터를 준비하고 있어요…', sendList); footer.hidden = false;
          const version = epoch;
          const doc = await snapshotSelection(listItems.filter(item => selection.has(itemId(item))));
          if (!alive(version)) return;
          const sender = new ShareSender({ state: (state, error) => {
            if (disposed || session !== sender) return;
            if (['closed', 'done', 'expired', 'error'].includes(state)) terminalSend(state, error);
            else if (state === 'sending') {
              say('받는 기기에 전송하고 있어요…'); content.querySelector('.pill')?.replaceChildren(document.createTextNode('전송 중 · 링크 재사용 불가'));
              const progress = content.querySelector('progress'); if (progress) progress.hidden = false;
            }
          }, progress: progress => { if (!disposed && session === sender) { const bar = content.querySelector('progress'); if (bar) bar.value = progress; } } });
          session = sender;
          const link = await sender.start(doc);
          if (!alive(version) || !link || sender.closed) { sender.close(); return; }
          view('다른 기기에서 열어 주세요', 'QR을 스캔하거나 전송 링크를 붙여넣으세요.', () => { stopSession(); sendList(); });
          content.append(element('div', '한 번만 사용 · 10분 후 만료', { class: 'pill' }), qrImage(link));
          const address = element('textarea', '', { readonly: '', rows: '3', class: 'link', 'aria-label': '전송 링크' }); address.value = link;
          const bar = element('progress', '', { max: '1', value: '0', 'aria-label': '전송 진행률' });
          bar.hidden = true;
          content.append(address, bar);
          footer.append(element('p', '이 창을 열어 두세요. 링크를 아는 사람은 받을 수 있고, 이미 받은 데이터는 회수할 수 없습니다.', { class: 'muted tiny' }));
          cta('링크 복사', async () => {
            assert(!sender.closed, '종료된 전송입니다.');
            try {
              if (typeof GM_setClipboard === 'function') GM_setClipboard(address.value, 'text');
              else await navigator.clipboard.writeText(address.value);
              say('복사했어요. 다른 기기의 받기 화면에 붙여넣으세요.');
            } catch { address.focus(); address.select(); say('링크를 길게 누르거나 복사 단축키로 복사해 주세요.'); }
          });
          cta('전송 종료', () => sender.close(), true);
        }
        function terminalSend(reason, error) {
          const done = reason === 'done';
          view(done ? '전송을 마쳤어요' : '전송 링크가 끝났어요', done ? '받는 기기에서 저장할 항목을 확인해 주세요.' : reason === 'expired' ? '10분이 지나 링크가 자동으로 만료됐어요.' : '이 링크로는 더 이상 받을 수 없어요.', null);
          content.append(element('div', done ? '✓' : '↗', { class: 'big-icon center' }));
          if (error) say(errorText(error), true);
          cta('닫기', () => dispose());
          if (!done) cta('새 링크 만들기', sendList, true);
        }

        // 링크로 받은 데이터는 우선 메모리에만 둡니다. 저장 버튼을 누르기 전에는 대상 저장소를 바꾸지 않습니다.
        function receivePage(prefilled = '', auto = false) {
          stopSession(); view('전송 링크로 받기', '보내는 기기에서 만든 링크를 붙여넣으세요.'); footer.hidden = false;
          const field = element('textarea', '', { rows: '4', placeholder: 'https://crack.wrtn.ai/#csb2=…', 'aria-label': '받을 전송 링크', spellcheck: 'false' });
          field.value = prefilled; content.append(field);
          cta('연결하기', () => connect(field.value));
          if (auto) perform(() => connect(prefilled));
        }
        async function connect(text) {
          parseInvitation(text);
          view('데이터를 받는 중', '두 기기의 브라우저를 열어 두세요.', () => receivePage());
          const bar = element('progress', '', { max: '1', value: '0', 'aria-label': '수신 진행률' }); content.append(bar);
          cta('취소', () => { stopSession(); receivePage(); }, true);
          const receiver = new ShareReceiver({ progress: value => { if (!disposed) bar.value = value; }, data: doc => {
            if (disposed || session !== receiver || !mainPage()) return;
            incoming = doc; listItems = itemsFromDocument(doc); selection = new Set(listItems.map(itemId)); filter = ''; receivedList();
          }, error: error => {
            if (disposed || session !== receiver) return;
            view('연결하지 못했어요', '보내는 쪽이 열려 있는지 확인해 주세요.', () => receivePage()); say(errorText(error), true); cta('링크 다시 입력', () => receivePage());
          } });
          session = receiver; await receiver.start(text);
        }
        function receivedList() {
          view('이 기기에 저장할까요?', '받은 데이터입니다. 저장할 항목을 선택해 주세요.', () => receivePage()); footer.hidden = false;
          renderList(true, receivedList);
          content.append(element('div', '같은 설정 키는 덮어쓰고, 선택한 DB는 내용 전체를 교체합니다. 관련 스크립트의 작업을 멈추고 다른 Crack 탭을 닫아 주세요. 이 창을 닫기 전까지 되돌릴 수 있습니다.', { class: 'notice' }));
          const save = cta(`선택한 ${selection.size}개 덮어쓰기`, saveReceived); save.disabled = selection.size === 0;
        }
        async function saveReceived() {
          assert(incoming && selection.size, '저장할 항목을 선택해 주세요.');
          restoreTarget = selectedDocument(incoming, selection);
          writing = true; close.disabled = true; back.disabled = true;
          try {
            view('저장하는 중', '기존 데이터를 잠시 보관하고 있어요…', null);
            backup = await recoverySnapshot(restoreTarget);
            const execute = () => restore(restoreTarget, backup, text => say(text), () => !mainPage() || disposed);
            const result = navigator.locks?.request
              ? await navigator.locks.request('crack-storage-bridge-restore', { ifAvailable: true }, lock => { assert(lock, '다른 탭에서 저장 중입니다.'); return execute(); })
              : await execute();
            if (disposed) return;
            view('저장했어요', '관련 스크립트를 다시 켜고 새로고침해 주세요.', null);
            content.append(element('div', '✓', { class: 'big-icon center' }), element('p', result.join(' · '), { class: 'muted center' }),
              element('p', '닫기·새로고침 후에는 이 창의 되돌리기가 사라집니다.', { class: 'notice' }));
            cta('완료 · 닫기', () => dispose()); cta('방금 저장한 데이터 되돌리기', undo, true);
          } catch (error) {
            if (disposed) return;
            view('저장을 마치지 못했어요', '아래 결과를 확인해 주세요.', null); say(errorText(error), true);
            if (backup) cta('저장 전으로 되돌리기', undo);
            cta('닫기', () => dispose(), true);
          } finally { writing = false; close.disabled = false; back.disabled = false; }
        }
        async function undo() {
          assert(backup, '이 창에 되돌릴 데이터가 없습니다.');
          writing = true; close.disabled = true;
          try {
            view('저장 전으로 되돌리는 중', '잠시 기다려 주세요.', null);
            const execute = async () => restore(backup, await recoverySnapshot(backup), text => say(text), () => !mainPage() || disposed);
            if (navigator.locks?.request) await navigator.locks.request('crack-storage-bridge-restore', { ifAvailable: true }, lock => { assert(lock, '다른 탭에서 저장 중입니다.'); return execute(); });
            else await execute();
            backup = null; restoreTarget = null;
            view('이전 데이터로 되돌렸어요', '관련 스크립트를 다시 켜고 새로고침해 주세요.', null); cta('완료 · 닫기', () => dispose());
          } catch (error) {
            view('되돌리기를 마치지 못했어요', '데이터는 이 창에 계속 보관하고 있어요.', null); say(errorText(error), true);
            cta('다시 되돌리기', undo);
          } finally { writing = false; close.disabled = false; }
        }
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
  }

  // ── 진입점: 메인페이지에서만 화면을 초기화합니다.
  boot();
})();
