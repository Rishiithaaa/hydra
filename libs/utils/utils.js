
window.__hydrate__ = [];

// -------- Part 1: Prerequisite Helpers --------

function generateId() {
  // Simple random ID generator
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Ensures DOM elements have hydration IDs and returns the ID info. (SSR Context)
 * Assigns 'data-hydrate-id' or 'data-hydrate-multi'.
 */
function ensureHydrateId(elementOrList) {
  // ... (Implementation from the previous detailed answer) ...
  if (!elementOrList) return null;
  if (typeof elementOrList === "string") {
    return null;
  }
  // if(elementOrList instanceof MediaQueryList) {
  //   return `MediaQueryList-${elementOrList.media}`;
  // }
  if (elementOrList instanceof HTMLElement) {
    let id = elementOrList.getAttribute('data-hydrate-id');
    if (!id) { id = `sh-${generateId()}`; elementOrList.setAttribute('data-hydrate-id', id); }
    return id;
  }
  if (typeof elementOrList[Symbol.iterator] === 'function' && typeof elementOrList.length === 'number') {
    if (elementOrList.length === 0) return [];
    let ids = new Set(); let assignedMultiId = null;
    for (const el of elementOrList) {
      if (!(el instanceof HTMLElement)) { continue; }
      let existingMultiId = el.getAttribute('data-hydrate-multi');
      if (!existingMultiId) { if (!assignedMultiId) assignedMultiId = `mh-${generateId()}`; el.setAttribute('data-hydrate-multi', assignedMultiId); ids.add(assignedMultiId); }
      else { ids.add(existingMultiId); }
    } return Array.from(ids);
  } return null;
}

const CLASS_REGISTRY = {};
export function makeSerializable(Class) {
    const className = Class.name;
    if (!className) {
        console.error("makeSerializable requires a named class.");
        return Class; // Return original if anonymous
    }
    if (!CLASS_REGISTRY[className]) {
         CLASS_REGISTRY[className] = Class;
    } else {}

    // Add toJSON to the ORIGINAL class prototype if it doesn't exist
    if (!Class.prototype.hasOwnProperty('toJSON')) {
        Class.prototype.toJSON = function() {};
    }

     // --- User's Wrapper Approach ---
    const WrappedClass = class extends Class {
        constructor(...args) {
            super(...args);
             Object.defineProperty(this, '__args', {
                 value: args,
                 enumerable: false, // Keep it out of for...in and Object.keys/entries
                 writable: false,
                 configurable: true // Allows deletion if needed
             });
        }
    };

    WrappedClass.prototype.toJSON = function() {
        // Get other instance properties (own enumerable)
        const otherProps = {};
        for (const key in this) {
             if (Object.prototype.hasOwnProperty.call(this, key)) {
                 otherProps[key] = this[key];
             }
         }

        return {
           __type__: className,
            __type: className,
            __args: this.__args || [],
            ...otherProps
        };
    };
    return WrappedClass;
}

/**
 * Custom serialization: Handles DOM elements/NodeLists AND uses makeSerializable's toJSON.
 *
 * @param {*} value The value to serialize.
 * @returns {string} The JSON string representation.
 */
function customStringifyWithDom(value) {
  const visited = new WeakSet();
  const replacer = (key, val) => {
    if (val instanceof HTMLBodyElement) {
      return { "__type__": "HTMLBodyElement"};
    }
    if (val instanceof HTMLElement || val instanceof NodeList) {
        const idInfo = ensureHydrateId(val);
        if (idInfo) {
            if (Array.isArray(idInfo)) return { "__type__": "NodeList", "ids": idInfo };
            else return { "__type__": "HTMLElement", "id": idInfo };
        } else {
             if(val instanceof NodeList && val.length === 0) return { "__type__": "NodeList", "ids": [] };
            return null;
        }
    }

    if (typeof val === 'object' && val !== null) {
      if (visited.has(val)) throw new Error('Circular reference detected');
      visited.add(val);
    }

    // 3. Let JSON.stringify handle the rest. If 'val' is an instance of a
    //    class wrapped by makeSerializable, stringify will call its toJSON.
    return val;
  };

  return JSON.stringify(value, replacer);
}

/**
 * Custom deserialization function: Revives DOM elements/NodeLists AND
 * custom classes using the CLASS_REGISTRY populated by makeSerializable.
 * Reconstructs classes using the __args property.
 *
 * @param {string} jsonString The JSON string to parse.
 * @returns {*} The deserialized value.
 */
/**
 * Custom deserialization function - DEBUGGING VERSION.
 */
function customParseWithDomAndClasses(jsonString, registry) {
  // CLASS_REGISTRY should be populated on the client side by makeSerializable
  // *** DEBUG STEP 1: Verify Registry ***
  console.log("DEBUG: Using CLASS_REGISTRY:", registry);
  if (Object.keys(registry).length === 0) {
      console.warn("DEBUG: CLASS_REGISTRY is empty! Ensure makeSerializable(YourClass) ran on the client.");
  }


  const reviver = (key, value) => {
    // Check if 'value' is an object, not null, and has our special __type__ property
    if (typeof value === 'object' && value !== null && (value.hasOwnProperty('__type__') || value.hasOwnProperty('__type'))) {
      const type = value.__type__;

      // --- Revive DOM Elements/NodeLists (Keep this logic) ---
      if (type === "HTMLElement" && typeof value.id === 'string') {
          const element = document.querySelector(`[data-hydrate-id="${value.id}"]`);
          // console.log(`DEBUG: Revived HTMLElement for type "${type}", key "${key}". Found:`, !!element);
          return element;
       }

      if (type === "HTMLBodyElement") {
        return document.body;
      }
       if (type === "NodeList" && Array.isArray(value.ids)) {
            let nodeList;
            if(value.ids.length > 0) {
               nodeList = document.querySelectorAll(value.ids.map(mId => `[data-hydrate-multi="${mId}"]`).join(','));
            } else {
               nodeList = document.querySelectorAll(`.non-existent-${Date.now()}`); // Empty NodeList
            }
            // console.log(`DEBUG: Revived NodeList for type "${type}", key "${key}". Length:`, nodeList.length);
            return nodeList;
       }


      // --- Revive Custom Classes ---
      const Constructor = registry[type].inh;
      // *** DEBUG STEP 2: Check Constructor Lookup ***
      console.log(`DEBUG: Found __type__="${type}" for key "${key}". Attempting lookup in registry... Found Constructor:`, Constructor ? Constructor.name : 'NO');

      if (Constructor && typeof Constructor === 'function') {
         // Check if __args property exists (meaning it was serialized by makeSerializable wrapper)
         if (value.hasOwnProperty('__args') && Array.isArray(value.__args)) {
            try {
                // *** DEBUG STEP 3: Check Instantiation ***
                console.log(`DEBUG: Attempting 'new ${type}(...args)' with args:`, JSON.stringify(value.__args));
                const instance = new Constructor(...value.__args); // <<< INSTANTIATION HAPPENS HERE
                // Apply other serialized properties that were not constructor args
                const otherState = { ...value };
                delete otherState.__type;
                delete otherState.__args;
                Object.assign(instance, otherState);
                console.log(`DEBUG: State assigned. Prototype is now:`, Object.getPrototypeOf(instance)); // Should NOT have changed

                console.log(`DEBUG: RETURNING INSTANCE for type "${type}"`, instance);
                return instance; // *** This should return the object with the correct prototype ***
            } catch (e) {
                 console.error(`DEBUG: Error during 'new ${type}(...args)':`, e, "Args:", value.__args, "Value:", value);
                 return value; // Return original object on error
            }
         } else {
             console.warn(`DEBUG: Cannot revive class ${type} using __args: __args property missing or not an array.`);
             return value; // Return original object if cannot revive
         }
      } else {
          // Constructor not found in registry
           console.warn(`DEBUG: Constructor for type "${type}" not found in registry or not a function.`);
      }
    }
    // Return value unchanged if it's not a marker object we handle
    return value;
  }; // End Reviver

  try {
      return JSON.parse(jsonString, reviver);
  } catch (e) {
      console.error("Error during customParse:", e);
      return undefined;
  }
}

window.customParseWithDomAndClasses = customParseWithDomAndClasses;
window.makeSerializable = makeSerializable;
window.customStringifyWithDom = customStringifyWithDom;



// == SSR / Puppeteer Side ==
/*
function runSSR() {
    try {
        console.log("SSR: Running example...");
        // *** Use the WRAPPED constructors for instances to be serialized ***
        const p = new SerializablePoint(10, 20);
        const c = new SerializableCircle(5, p); // Pass revived 'p' or new SerializablePoint

        const someDiv = document.createElement('div'); // Create element
        document.body.appendChild(someDiv);
        // Need to access original methods if they weren't on wrapped prototype?
        // makeSerializable puts them on prototype via inheritance.
        c.setElement(someDiv); // Associate element (method is inherited)

        const dataToSerialize = { myCircle: c, startPoint: p };
        // Use the stringify that handles DOM elements
        const serialized = customStringifyWithDom(dataToSerialize);
        console.log("SSR Serialized:", serialized);
        // Expected output includes __type__, __args, other props for classes, and element markers

        document.body.removeChild(someDiv); // Clean up

        // Embed 'serialized' in HTML response for the client
        // e.g., <script type="application/json" id="hydrationData">${serialized}</script>
    } catch (error) {
        console.error("SSR Error:", error);
    }
}
// runSSR();
*/

// == Client Side ==
/*
function runClient() {
    console.log("Client: Running example...");
    // CLASS_REGISTRY should be populated from makeSerializable calls running on client

    // Get the raw JSON string
    const dataElement = document.getElementById('hydrationData');
    const rawJsonString = dataElement ? dataElement.textContent : null;
    // const rawJsonString = window.__HYDRATION_DATA_RAW__; // Alternate way

    if (rawJsonString) {
        console.log("Client Raw JSON:", rawJsonString);
        // Parse using the combined reviver
        const revivedData = customParseWithDomAndClasses(rawJsonString);
        console.log("Client Revived:", revivedData);

        // Use the revived data - instances should be of the ORIGINAL types (Point, Circle)
        if (revivedData && revivedData.myCircle instanceof Circle && revivedData.startPoint instanceof Point) {
            console.log("Client: Revival successful!");
            revivedData.myCircle.display(); // Should work
            revivedData.startPoint.display(); // Should work

            if (revivedData.myCircle.center instanceof Point) {
                console.log("Client: Nested Point revived correctly.");
            }
            if (revivedData.myCircle.relatedElement instanceof HTMLElement) {
                console.log("Client: Element reference revived correctly!");
                revivedData.myCircle.relatedElement.style.outline = '3px dashed purple';
            } else {
                 console.warn("Client: Element reference was not revived correctly.");
            }
        } else {
            console.error("Client: Revival failed or data structure mismatch!");
        }
    } else {
         console.log("Client: No hydration data found.");
    }
}

// Run on client after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runClient);
} else {
  runClient();
}
*/

window.hydrate = function(config) {
  // Destructure config for clarity
  const { id, payload } = config;

  // Basic validation
  if (id === undefined || id === null) {
    console.error('Hydration config must include an "id".');
    return;
  }

  let file = null;
  try {
    throw new Error();
  } catch (e) {
    const stackLines = e.stack.split('\n');
    const callerLine = stackLines[2] || stackLines[1];

    const match = callerLine.match(/(https?:\/\/.+?):\d+:\d+/);
    if (match && match[1]) {
      const url = new URL(match[1]);
      const segments = url.pathname.split('/').filter(Boolean); // remove empty strings
      file = segments.slice(-2).join('/');
    }
  }
  const task = {
    id,
    file,
    elements: {},
    data: {},
  };

  // Process the payload object to categorize items
  Object.entries(payload||{}).forEach(([key, value]) => {
    // Attempt to get hydration ID(s) for the value
    const hydrationIdInfo = ensureHydrateId(value);

    if (hydrationIdInfo !== null) {
      // If ensureHydrateId returned an ID string or an array of IDs, treat as element(s)
      task.elements[key] = hydrationIdInfo;
    } else if (value !== null && !(value instanceof HTMLElement) && typeof value?.length !== 'number'){
      // If it wasn't recognized as an element/list by ensureHydrateId,
      // and it's not null/HTMLElement/array-like, treat it as data.
      // (We re-check null/HTMLElement/length here for safety, though ensureHydrateId handles most)
      try {
        // Attempt to stringify/parse to ensure valid JSON & deep clone primitive/plain objects/arrays
        task.data[key] = JSON.parse(JSON.stringify(value));
      } catch (e) {
        console.warn(`Hydration (id: ${id}): Could not serialize data for key "${key}". Skipping. Error:`, e);
        // Optionally store a placeholder like null or skip the key
        // task.data[key] = null;
      }
    }else if (value !== null && !(value instanceof HTMLElement) && typeof value === "string"){
      // If it wasn't recognized as an element/list by ensureHydrateId,
      // and it's not null/HTMLElement/array-like, treat it as data.
      // (We re-check null/HTMLElement/length here for safety, though ensureHydrateId handles most)
      try {
        // Attempt to stringify/parse to ensure valid JSON & deep clone primitive/plain objects/arrays
        task.data[key] = value;
      } catch (e) {
        console.warn(`Hydration (id: ${id}): Could not serialize data for key "${key}". Skipping. Error:`, e);
        // Optionally store a placeholder like null or skip the key
        // task.data[key] = null;
      }
    }
    // If value is null or an empty list, ensureHydrateId returns null,
    // and it won't match the 'else if' either, so it's correctly skipped.
  });
  window.__hydrate__.push(task);
};



const MILO_TEMPLATES = [
  '404',
  'featured-story',
];
const MILO_BLOCKS = [
  'accordion',
  'action-item',
  'action-scroller',
  'adobetv',
  'article-feed',
  'article-header',
  'aside',
  'author-header',
  'brick',
  'bulk-publish',
  'bulk-publish-v2',
  'caas',
  'caas-config',
  'caas-marquee',
  'caas-marquee-metadata',
  'card',
  'card-horizontal',
  'card-metadata',
  'carousel',
  'chart',
  'columns',
  'editorial-card',
  'faas',
  'featured-article',
  'figure',
  'form',
  'fragment',
  'featured-article',
  'global-footer',
  'global-navigation',
  'graybox',
  'footer',
  'gnav',
  'hero-marquee',
  'how-to',
  'icon-block',
  'iframe',
  'instagram',
  'locui',
  'locui-create',
  'm7',
  'marketo',
  'marquee',
  'marquee-anchors',
  'martech-metadata',
  'media',
  'merch',
  'merch-card',
  'merch-card-autoblock',
  'merch-card-collection',
  'merch-card-collection-autoblock',
  'merch-offers',
  'mmm',
  'mnemonic-list',
  'mobile-app-banner',
  'modal',
  'modal-metadata',
  'notification',
  'pdf-viewer',
  'quote',
  'read-more',
  'recommended-articles',
  'region-nav',
  'review',
  'section-metadata',
  'slideshare',
  'preflight',
  'promo',
  'quiz',
  'quiz-entry',
  'quiz-marquee',
  'quiz-results',
  'tabs',
  'table-of-contents',
  'text',
  'timeline',
  'walls-io',
  'table',
  'table-metadata',
  'tags',
  'tag-selector',
  'tiktok',
  'twitter',
  'video',
  'vimeo',
  'youtube',
  'z-pattern',
  'share',
  'reading-time',
];
const AUTO_BLOCKS = [
  { adobetv: 'tv.adobe.com' },
  { gist: 'gist.github.com' },
  { caas: '/tools/caas' },
  { faas: '/tools/faas' },
  { fragment: '/fragments/', styles: false },
  { instagram: 'instagram.com' },
  { slideshare: 'slideshare.net', styles: false },
  { tiktok: 'tiktok.com', styles: false },
  { twitter: 'twitter.com' },
  { vimeo: 'vimeo.com' },
  { vimeo: 'player.vimeo.com' },
  { youtube: 'youtube.com' },
  { youtube: 'youtu.be' },
  { 'pdf-viewer': '.pdf', styles: false },
  { video: '.mp4' },
  { merch: '/tools/ost?' },
  { merch: '/miniplans' },
  { 'merch-card-collection-autoblock': 'mas.adobe.com/studio.html#content-type=merch-card-collection', styles: false },
  { 'merch-card-autoblock': 'mas.adobe.com/studio.html', styles: false },
  { m7: '/creativecloud/business-plans', styles: false },
  { m7: '/creativecloud/education-plans', styles: false },
];
const DO_NOT_INLINE = [
  'accordion',
  'columns',
  'z-pattern',
];

const ENVS = {
  stage: {
    name: 'stage',
    ims: 'stg1',
    adobeIO: 'cc-collab-stage.adobe.io',
    adminconsole: 'stage.adminconsole.adobe.com',
    account: 'stage.account.adobe.com',
    edgeConfigId: '8d2805dd-85bf-4748-82eb-f99fdad117a6',
    pdfViewerClientId: 'a76f1668fd3244d98b3838e189900a5e',
  },
  prod: {
    name: 'prod',
    ims: 'prod',
    adobeIO: 'cc-collab.adobe.io',
    adminconsole: 'adminconsole.adobe.com',
    account: 'account.adobe.com',
    edgeConfigId: '2cba807b-7430-41ae-9aac-db2b0da742d5',
    pdfViewerClientId: '3c0a5ddf2cc04d3198d9e48efc390fa9',
  },
};
ENVS.local = {
  ...ENVS.stage,
  name: 'local',
};

export const MILO_EVENTS = { DEFERRED: 'milo:deferred' };
const TARGET_TIMEOUT_MS = 4000;

const LANGSTORE = 'langstore';
const PREVIEW = 'target-preview';
const PAGE_URL = new URL(window.location.href);
export const SLD = PAGE_URL.hostname.includes('.aem.') ? 'aem' : 'hlx';

const PROMO_PARAM = 'promo';
let isMartechLoaded = false;

export function getEnv(conf) {
  const { host } = window.location;
  const query = PAGE_URL.searchParams.get('env');

  if (query) return { ...ENVS[query], consumer: conf[query] };

  const { clientEnv } = conf;
  if (clientEnv) return { ...ENVS[clientEnv], consumer: conf[clientEnv] };

  if (host.includes('localhost')) return { ...ENVS.local, consumer: conf.local };
  /* c8 ignore start */
  if (host.includes(`${SLD}.page`)
    || host.includes(`${SLD}.live`)
    || host.includes('stage.adobe')
    || host.includes('corp.adobe')
    || host.includes('graybox.adobe')) {
    return { ...ENVS.stage, consumer: conf.stage };
  }
  return { ...ENVS.prod, consumer: conf.prod };
  /* c8 ignore stop */
}

export function getLocale(locales, pathname = window.location.pathname) {
  if (!locales) {
    return { ietf: 'en-US', tk: 'hah7vzn.css', prefix: '' };
  }
  const split = pathname.split('/');
  const localeString = split[1];
  let locale = locales[localeString] || locales[''];
  if ([LANGSTORE, PREVIEW].includes(localeString)) {
    const ietf = Object.keys(locales).find((loc) => locales[loc]?.ietf?.startsWith(split[2]));
    if (ietf) locale = locales[ietf];
    locale.prefix = `/${localeString}/${split[2]}`;
    return locale;
  }
  const isUS = locale.ietf === 'en-US';
  locale.prefix = isUS ? '' : `/${localeString}`;
  locale.region = isUS ? 'us' : localeString.split('_')[0];
  return locale;
}

export function getMetadata(name, doc = document) {
  const attr = name && name.includes(':') ? 'property' : 'name';
  const meta = doc.head.querySelector(`meta[${attr}="${name}"]`);
  return meta && meta.content;
}

const handleEntitlements = (() => {
  const { martech } = Object.fromEntries(PAGE_URL.searchParams);
  if (martech === 'off') return () => { };
  let entResolve;
  const entPromise = new Promise((resolve) => {
    entResolve = resolve;
  });

  return (resolveVal) => {
    if (resolveVal !== undefined) {
      entResolve(resolveVal);
    }
    return entPromise;
  };
})();

function setupMiloObj(config) {
  window.milo ||= {};
  window.milo.deferredPromise = new Promise((resolve) => {
    config.resolveDeferred = resolve;
  });
}

export const [setConfig, updateConfig, getConfig] = (() => {
  let config = {};
  return [
    (conf) => {
      const origin = conf.origin || window.location.origin;
      const pathname = conf.pathname || window.location.pathname;
      config = { env: getEnv(conf), ...conf };
      config.codeRoot = conf.codeRoot ? `${origin}${conf.codeRoot}` : origin;
      config.base = config.miloLibs || config.codeRoot;
      config.locale = pathname ? getLocale(conf.locales, pathname) : getLocale(conf.locales);
      config.autoBlocks = conf.autoBlocks ? [...AUTO_BLOCKS, ...conf.autoBlocks] : AUTO_BLOCKS;
      config.signInContext = conf.signInContext || {};
      config.doNotInline = conf.doNotInline
        ? [...DO_NOT_INLINE, ...conf.doNotInline]
        : DO_NOT_INLINE;
      const lang = getMetadata('content-language') || config.locale.ietf;
      document.documentElement.setAttribute('lang', lang);
      try {
        const dir = getMetadata('content-direction')
          || config.locale.dir
          || (config.locale.ietf && (new Intl.Locale(config.locale.ietf)?.textInfo?.direction))
          || 'ltr';
        document.documentElement.setAttribute('dir', dir);
      } catch (e) {
        console.log('Invalid or missing locale:', e);
      }
      config.locale.contentRoot = `${origin}${config.locale.prefix}${config.contentRoot ?? ''}`;
      config.useDotHtml = !PAGE_URL.origin.includes(`.${SLD}.`)
        && (conf.useDotHtml ?? PAGE_URL.pathname.endsWith('.html'));
      config.entitlements = handleEntitlements;
      config.consumerEntitlements = conf.entitlements || [];
      setupMiloObj(config);
      return config;
    },
    (conf) => (config = conf),
    () => config,
  ];
})();

let federatedContentRoot;
/* eslint-disable import/prefer-default-export */
export const getFederatedContentRoot = () => {
  const cdnWhitelistedOrigins = [
    'https://www.adobe.com',
    'https://business.adobe.com',
    'https://blog.adobe.com',
    'https://milo.adobe.com',
    'https://news.adobe.com',
  ];
  const { allowedOrigins = [], origin: configOrigin } = getConfig();
  if (federatedContentRoot) return federatedContentRoot;
  // Non milo consumers will have its origin from config
  const origin = configOrigin || window.location.origin;

  federatedContentRoot = [...allowedOrigins, ...cdnWhitelistedOrigins].some((o) => origin.replace('.stage', '') === o)
    ? origin
    : 'https://www.adobe.com';

  if (origin.includes('localhost') || origin.includes(`.${SLD}.`)) {
    federatedContentRoot = `https://main--federal--adobecom.aem.${origin.endsWith('.live') ? 'live' : 'page'}`;
  }

  return federatedContentRoot;
};

// TODO we should match the akamai patterns /locale/federal/ at the start of the url
// and make the check more strict.
export const getFederatedUrl = (url = '') => {
  if (typeof url !== 'string' || !url.includes('/federal/')) return url;
  if (url.startsWith('/')) return `${getFederatedContentRoot()}${url}`;
  try {
    const { pathname, search, hash } = new URL(url);
    return `${getFederatedContentRoot()}${pathname}${search}${hash}`;
  } catch (e) {
    window.lana?.log(`getFederatedUrl errored parsing the URL: ${url}: ${e.toString()}`);
  }
  return url;
};

let fedsPlaceholderConfig;
export const getFedsPlaceholderConfig = ({ useCache = true } = {}) => {
  if (useCache && fedsPlaceholderConfig) return fedsPlaceholderConfig;

  const { locale, placeholders } = getConfig();
  const libOrigin = getFederatedContentRoot();

  fedsPlaceholderConfig = {
    locale: {
      ...locale,
      contentRoot: `${libOrigin}${locale.prefix}/federal/globalnav`,
    },
    placeholders,
  };

  return fedsPlaceholderConfig;
};

export function isInTextNode(node) {
  return (node.parentElement.childNodes.length > 1 && node.parentElement.firstChild.tagName === 'A') || node.parentElement.firstChild.nodeType === Node.TEXT_NODE;
}

export function createTag(tag, attributes, html, options = {}) {
  const el = document.createElement(tag);
  if (html) {
    if (html instanceof HTMLElement
      || html instanceof SVGElement
      || html instanceof DocumentFragment) {
      el.append(html);
    } else if (Array.isArray(html)) {
      el.append(...html);
    } else {
      el.insertAdjacentHTML('beforeend', html);
    }
  }
  if (attributes) {
    Object.entries(attributes).forEach(([key, val]) => {
      el.setAttribute(key, val);
    });
  }
  options.parent?.append(el);
  return el;
}

function getExtension(path) {
  const pageName = path.split('/').pop();
  return pageName.includes('.') ? pageName.split('.').pop() : '';
}

export function localizeLink(
  href,
  originHostName = window.location.hostname,
  overrideDomain = false,
) {
  try {
    const url = new URL(href);
    const relative = url.hostname === originHostName;
    const processedHref = relative ? href.replace(url.origin, '') : href;
    const { hash } = url;
    if (hash.includes('#_dnt')) return processedHref.replace('#_dnt', '');
    const path = url.pathname;
    const extension = getExtension(path);
    const allowedExts = ['', 'html', 'json'];
    if (!allowedExts.includes(extension)) return processedHref;
    const { locale, locales, prodDomains } = getConfig();
    if (!locale || !locales) return processedHref;
    const isLocalizable = relative || (prodDomains && prodDomains.includes(url.hostname))
      || overrideDomain;
    if (!isLocalizable) return processedHref;
    const isLocalizedLink = path.startsWith(`/${LANGSTORE}`)
      || path.startsWith(`/${PREVIEW}`)
      || Object.keys(locales).some((loc) => loc !== '' && (path.startsWith(`/${loc}/`)
        || path.endsWith(`/${loc}`)));
    if (isLocalizedLink) return processedHref;
    const urlPath = `${locale.prefix}${path}${url.search}${hash}`;
    return relative ? urlPath : `${url.origin}${urlPath}`;
  } catch (error) {
    return href;
  }
}

export function loadLink(href, { as, callback, crossorigin, rel, fetchpriority } = {}) {
  let link = document.head.querySelector(`link[href="${href}"]`);
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', rel);
    if (as) link.setAttribute('as', as);
    if (crossorigin) link.setAttribute('crossorigin', crossorigin);
    if (fetchpriority) link.setAttribute('fetchpriority', fetchpriority);
    link.setAttribute('href', href);
    if (callback) {
      link.onload = (e) => callback(e.type);
      link.onerror = (e) => callback(e.type);
    }
    document.head.appendChild(link);
  } else if (callback) {
    callback('noop');
  }
  return link;
}

export function loadStyle(href, callback) {
  return loadLink(href, { rel: 'stylesheet', callback });
}

export function appendHtmlToCanonicalUrl() {
  const { useDotHtml } = getConfig();
  if (!useDotHtml) return;
  const canonEl = document.head.querySelector('link[rel="canonical"]');
  if (!canonEl) return;
  const canonUrl = new URL(canonEl.href);
  if (canonUrl.pathname.endsWith('/') || canonUrl.pathname.endsWith('.html')) return;
  const pagePath = PAGE_URL.pathname.replace('.html', '');
  if (pagePath !== canonUrl.pathname) return;
  canonEl.setAttribute('href', `${canonEl.href}.html`);
}

export function appendSuffixToTitles() {
  const appendage = getMetadata('title-append');
  if (!appendage) return;
  document.title = `${document.title} ${appendage}`;
  const ogTitleEl = document.querySelector('meta[property="og:title"]');
  if (ogTitleEl) ogTitleEl.setAttribute('content', document.title);
  const twitterTitleEl = document.querySelector('meta[name="twitter:title"]');
  if (twitterTitleEl) twitterTitleEl.setAttribute('content', document.title);
}

export function appendHtmlToLink(link) {
  const { useDotHtml } = getConfig();
  if (!useDotHtml) return;
  const href = link.getAttribute('href');
  if (!href?.length) return;

  const { autoBlocks = [], htmlExclude = [] } = getConfig();

  const HAS_EXTENSION = /\..*$/;
  let url = { pathname: href };

  try { url = new URL(href, PAGE_URL); } catch (e) { /* do nothing */ }

  if (!(href.startsWith('/') || href.startsWith(PAGE_URL.origin))
    || url.pathname?.endsWith('/')
    || href === PAGE_URL.origin
    || HAS_EXTENSION.test(href.split('/').pop())
    || htmlExclude?.some((excludeRe) => excludeRe.test(href))) {
    return;
  }

  const relativeAutoBlocks = autoBlocks
    .map((b) => Object.values(b)[0])
    .filter((b) => b.startsWith('/'));
  const isAutoblockLink = relativeAutoBlocks.some((block) => href.includes(block));
  if (isAutoblockLink) return;

  try {
    const linkUrl = new URL(href.startsWith('http') ? href : `${PAGE_URL.origin}${href}`);
    if (linkUrl.pathname && !linkUrl.pathname.endsWith('.html')) {
      linkUrl.pathname = `${linkUrl.pathname}.html`;
      link.setAttribute('href', href.startsWith('/')
        ? `${linkUrl.pathname}${linkUrl.search}${linkUrl.hash}`
        : linkUrl.href);
    }
  } catch (e) {
    window.lana?.log(`Error while attempting to append '.html' to ${link}: ${e}`);
  }
}

export const loadScript = (url, type, { mode } = {}) => new Promise((resolve, reject) => {
  let script = document.querySelector(`head > script[src="${url}"]`);
  if (!script) {
    const { head } = document;
    script = document.createElement('script');
    script.setAttribute('src', url);
    if (type) {
      script.setAttribute('type', type);
    }
    if (['async', 'defer'].includes(mode)) script.setAttribute(mode, true);
    head.append(script);
  }

  if (script.dataset.loaded) {
    resolve(script);
    return;
  }

  const onScript = (event) => {
    script.removeEventListener('load', onScript);
    script.removeEventListener('error', onScript);

    if (event.type === 'error') {
      reject(new Error(`error loading script: ${script.src}`));
    } else if (event.type === 'load') {
      script.dataset.loaded = true;
      resolve(script);
    }
  };

  script.addEventListener('load', onScript);
  script.addEventListener('error', onScript);
});

export async function loadTemplate() {
  const template = getMetadata('template');
  if (!template) return;
  const name = template.toLowerCase().replace(/[^0-9a-z]/gi, '-');
  document.body.classList.add(name);
  const { miloLibs, codeRoot } = getConfig();
  const base = miloLibs && MILO_TEMPLATES.includes(name) ? miloLibs : codeRoot;
  const styleLoaded = new Promise((resolve) => {
    loadStyle(`${base}/templates/${name}/${name}.css`, resolve);
  });
  const scriptLoaded = new Promise((resolve) => {
    (async () => {
      try {
        await import(`${base}/templates/${name}/${name}.js`);
      } catch (err) {
        console.log(`failed to load module for ${name}`, err);
      }
      resolve();
    })();
  });
  await Promise.all([styleLoaded, scriptLoaded]);
}

function getBlockData(block) {
  const name = block.classList[0];
  const { miloLibs, codeRoot, mep } = getConfig();
  const base = miloLibs && MILO_BLOCKS.includes(name) ? miloLibs : codeRoot;
  let path = `${base}/blocks/${name}`;
  if (mep?.blocks?.[name]) path = mep.blocks[name];
  const blockPath = `${path}/${name}`;
  const hasStyles = AUTO_BLOCKS.find((ab) => Object.keys(ab).includes(name))?.styles ?? true;

  return { blockPath, name, hasStyles };
}

export async function loadBlock(block) {
  if (block.classList.contains('hide-block')) {
    block.remove();
    return null;
  }
  const { name, blockPath, hasStyles } = getBlockData(block);
  const styleLoaded = hasStyles && new Promise((resolve) => {
    loadStyle(`${blockPath}.css`, resolve);
  });
  const scriptLoaded = new Promise((resolve) => {
    (async () => {
      try {
        const { default: init } = await import(`${blockPath}.js`);
        await init(block);
        block.dataset.blockStatus = 'loaded';
      } catch (err) {
        console.log(`Failed loading ${name}`, err);
        const config = getConfig();
        if (config.env.name !== 'prod') {
          const { showError } = await import('../blocks/fallback/fallback.js');
          showError(block, name);
        }
      }
      resolve();
    })();
  });

  await Promise.all([styleLoaded, scriptLoaded]);
  return block;
}

export function decorateSVG(a) {
  const { textContent, href } = a;
  if (!(textContent.includes('.svg') || href.includes('.svg'))) return a;
  try {
    // Mine for URL and alt text
    const splitText = textContent.split('|');
    const authoredUrl = new URL(splitText.shift().trim());
    const altText = splitText.join('|').trim();

    // Relative link checking
    const hrefUrl = a.href.startsWith('/')
      ? new URL(`${window.location.origin}${a.href}`)
      : new URL(a.href);

    const src = (authoredUrl.hostname.includes('.hlx.') || authoredUrl.hostname.includes('.aem.'))
      ? authoredUrl.pathname
      : authoredUrl;

    const img = createTag('img', { loading: 'lazy', src, alt: altText || '' });
    const pic = createTag('picture', null, img);

    if (authoredUrl.pathname === hrefUrl.pathname) {
      a.parentElement.replaceChild(pic, a);
      return pic;
    }
    a.textContent = '';
    a.append(pic);
    return a;
  } catch (e) {
    console.log('Failed to create SVG.', e.message);
    return a;
  }
}

export function decorateImageLinks(el) {
  const images = el.querySelectorAll('img[alt*="|"]');
  if (!images.length) return;
  [...images].forEach((img) => {
    const [source, alt, icon] = img.alt.split('|');
    try {
      const url = new URL(source.trim());
      const href = url.hostname.includes(`.${SLD}.`) ? `${url.pathname}${url.hash}` : url.href;
      if (alt?.trim().length) img.alt = alt.trim();
      const pic = img.closest('picture');
      const picParent = pic.parentElement;
      if (href.includes('.mp4')) {
        const a = createTag('a', { href: url, 'data-video-poster': pic.outerHTML });
        a.innerHTML = url;
        pic.replaceWith(a);
      } else {
        const aTag = createTag('a', { href, class: 'image-link' });
        picParent.insertBefore(aTag, pic);
        if (icon) {
          import('./image-video-link.js').then((mod) => mod.default(picParent, aTag, icon));
        } else {
          aTag.append(pic);
        }
      }
    } catch (e) {
      console.log('Error:', `${e.message} '${source.trim()}'`);
    }
  });
}

export function isTrustedAutoBlock(autoBlock, url) {
  if (!url.href.includes(autoBlock)) return false;
  const urlHostname = url.hostname.replace('www.', '');
  const locationHostname = window.location.hostname.replace('www.', '');
  return urlHostname === locationHostname
    || urlHostname.endsWith('.adobe.com')
    || urlHostname === 'adobe.com'
    || urlHostname === autoBlock
    || !!urlHostname.match(/\.(hlx|aem)\.(page|live)$/)
    || (autoBlock === '.pdf' && url.pathname.endsWith(autoBlock));
}

export function decorateAutoBlock(a) {
  const config = getConfig();
  let url;
  try {
    url = new URL(a.href);
  } catch (e) {
    window.lana?.log(`Cannot make URL from decorateAutoBlock - ${a?.href}: ${e.toString()}`);
    return false;
  }

  return config.autoBlocks.find((candidate) => {
    const key = Object.keys(candidate)[0];
    if (!isTrustedAutoBlock(candidate[key], url)) return false;

    if (key === 'pdf-viewer' && !a.textContent.includes('.pdf')) {
      a.target = '_blank';
      return false;
    }

    const hasExtension = a.href.split('/').pop().includes('.');
    const mp4Match = a.textContent.match('media_.*.mp4');
    if (key === 'fragment' && (!hasExtension || mp4Match)) {
      if (a.href === window.location.href) {
        return false;
      }

      const isInlineFrag = url.hash.includes('#_inline');
      if (url.hash === '' || isInlineFrag) {
        const { parentElement } = a;
        const { nodeName, innerHTML } = parentElement;
        const noText = innerHTML === a.outerHTML;
        if (noText && nodeName === 'P') {
          const div = createTag('div', null, a);
          parentElement.parentElement.replaceChild(div, parentElement);
        }
      }

      // previewing a fragment page with mp4 video
      if (mp4Match) {
        a.className = 'video link-block';
        return false;
      }

      // Modals
      if (url.hash !== '' && !isInlineFrag) {
        a.dataset.modalPath = url.pathname;
        a.dataset.modalHash = url.hash;
        a.href = url.hash;
        a.className = `modal link-block ${[...a.classList].join(' ')}`;
        return true;
      }
    }

    // slack uploaded mp4s
    if (key === 'video' && !a.textContent.match('media_.*.mp4')) {
      return false;
    }

    a.className = `${key} link-block`;
    return true;
  });
}

const decorateCopyLink = (a, evt) => {
  const userAgent = navigator.userAgent.toLowerCase();
  const isMobile = /android|iphone|mobile/.test(userAgent) && !/ipad/.test(userAgent);
  if (!isMobile || !navigator.share) {
    a.remove();
    return;
  }
  const link = a.href.replace(evt, '');
  const isConButton = ['EM', 'STRONG'].includes(a.parentElement.nodeName)
    || a.classList.contains('con-button');
  if (!isConButton) a.classList.add('static', 'copy-link');
  a.href = '';
  a.addEventListener('click', async (e) => {
    e.preventDefault();
    if (navigator.share) await navigator.share({ title: link, url: link });
  });
};

export function convertStageLinks({ anchors, config, hostname, href }) {
  const { env, stageDomainsMap, locale } = config;
  if (env?.name === 'prod' || !stageDomainsMap) return;
  const matchedRules = Object.entries(stageDomainsMap)
    .find(([domain]) => (new RegExp(domain)).test(href));
  if (!matchedRules) return;
  const [, domainsMap] = matchedRules;
  [...anchors].forEach((a) => {
    const hasLocalePrefix = a.pathname.startsWith(`${locale.prefix}/`);
    const noLocaleLink = hasLocalePrefix ? a.href.replace(locale.prefix, '') : a.href;
    const matchedDomain = Object.keys(domainsMap)
      .find((domain) => (new RegExp(domain)).test(noLocaleLink));
    if (!matchedDomain) return;
    const convertedLink = noLocaleLink.replace(
      new RegExp(matchedDomain),
      domainsMap[matchedDomain] === 'origin'
        ? `${matchedDomain.includes('https') ? 'https://' : ''}${hostname}`
        : domainsMap[matchedDomain],
    );
    const convertedUrl = new URL(convertedLink);
    convertedUrl.pathname = `${hasLocalePrefix ? locale.prefix : ''}${convertedUrl.pathname}`;
    a.href = convertedUrl.toString();
    if (/(\.page|\.live).*\.html(?=[?#]|$)/.test(a.href)) a.href = a.href.replace(/\.html(?=[?#]|$)/, '');
  });
}

export function decorateLinks(el) {
  const config = getConfig();
  decorateImageLinks(el);
  const anchors = el.getElementsByTagName('a');
  const { hostname, href } = window.location;
  const links = [...anchors].reduce((rdx, a) => {
    appendHtmlToLink(a);
    if (a.href.includes('http:')) a.setAttribute('data-http-link', 'true');
    a.href = localizeLink(a.href);
    decorateSVG(a);
    if (a.href.includes('#_blank')) {
      a.setAttribute('target', '_blank');
      a.href = a.href.replace('#_blank', '');
    }
    if (a.href.includes('#_nofollow')) {
      a.setAttribute('rel', 'nofollow');
      a.href = a.href.replace('#_nofollow', '');
    }
    if (a.href.includes('#_dnb')) {
      a.href = a.href.replace('#_dnb', '');
    } else {
      const autoBlock = decorateAutoBlock(a);
      if (autoBlock) {
        rdx.push(a);
      }
    }
    // Custom action links
    const loginEvent = '#_evt-login';
    if (a.href.includes(loginEvent)) {
      a.href = a.href.replace(loginEvent, '');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const { signInContext } = config;
        window.adobeIMS?.signIn(signInContext);
      });
    }
    const copyEvent = '#_evt-copy';
    if (a.href.includes(copyEvent)) {
      decorateCopyLink(a, copyEvent);
    }
    const branchQuickLink = 'app.link';

    if (a.href.includes(branchQuickLink)) {
      (async () => {
        const { default: processQuickLink } = await import('../features/branch-quick-links/branch-quick-links.js');
        processQuickLink(a);
      })();
    }
    // Append aria-label
    const pipeRegex = /\s?\|([^|]*)$/;
    if (pipeRegex.test(a.textContent) && !/\.[a-z]+/i.test(a.textContent)) {
      const node = [...a.childNodes].reverse()[0];
      const ariaLabel = node.textContent.match(pipeRegex)[1];
      node.textContent = node.textContent.replace(pipeRegex, '');
      a.setAttribute('aria-label', ariaLabel.trim());
    }

    return rdx;
  }, []);
  convertStageLinks({ anchors, config, hostname, href });
  return links;
}

function decorateContent(el) {
  const children = [el];
  let child = el;
  while (child) {
    child = child.nextElementSibling;
    if (child && child.nodeName !== 'DIV') {
      children.push(child);
    } else {
      break;
    }
  }
  const block = document.createElement('div');
  block.className = 'content';
  block.append(...children);
  block.dataset.block = '';
  return block;
}

function decorateDefaults(el) {
  const firstChild = ':scope > *:not(div):first-child';
  const afterBlock = ':scope > div + *:not(div)';
  const children = el.querySelectorAll(`${firstChild}, ${afterBlock}`);
  children.forEach((child) => {
    const prev = child.previousElementSibling;
    const content = decorateContent(child);
    if (prev) {
      prev.insertAdjacentElement('afterend', content);
    } else {
      el.insertAdjacentElement('afterbegin', content);
    }
  });
}

export async function getGnavSource() {
  const { locale, dynamicNavKey } = getConfig();
  let url = getMetadata('gnav-source') || `${locale.contentRoot}/gnav`;
  if (dynamicNavKey) {
    const { default: dynamicNav } = await import('../features/dynamic-navigation/dynamic-navigation.js');
    url = dynamicNav(url, dynamicNavKey);
  }
  return url;
}

export function isLocalNav() {
  const { locale = {} } = getConfig();
  const gnavSource = getMetadata('gnav-source') || `${locale.contentRoot}/gnav`;
  let newNavEnabled = new URLSearchParams(window.location.search).get('newNav');
  newNavEnabled = newNavEnabled ? newNavEnabled !== 'false' : getMetadata('mobile-gnav-v2') !== 'off';
  return gnavSource.split('/').pop().startsWith('localnav-') && newNavEnabled;
}

async function decorateHeader() {
  const breadcrumbs = document.querySelector('.breadcrumbs');
  breadcrumbs?.remove();
  const header = document.querySelector('header');
  if (!header) return;
  const headerMeta = getMetadata('header');
  if (headerMeta === 'off') {
    document.body.classList.add('nav-off');
    header.remove();
    return;
  }
  header.className = headerMeta || 'global-navigation';
  const metadataConfig = getMetadata('breadcrumbs')?.toLowerCase()
    || getConfig().breadcrumbs;
  if (metadataConfig === 'off') return;
  const baseBreadcrumbs = getMetadata('breadcrumbs-base')?.length;

  const autoBreadcrumbs = getMetadata('breadcrumbs-from-url') === 'on';
  const dynamicNavActive = getMetadata('dynamic-nav') === 'on'
    && window.sessionStorage.getItem('gnavSource') !== null;
  if (!dynamicNavActive && (baseBreadcrumbs || breadcrumbs || autoBreadcrumbs)) header.classList.add('has-breadcrumbs');
  if (isLocalNav()) {
    // Preserving space to avoid CLS issue
    const localNavWrapper = createTag('div', { class: 'feds-localnav' });
    header.after(localNavWrapper);
  }
  if (breadcrumbs) header.append(breadcrumbs);
  const promo = getMetadata('gnav-promo-source');
  if (promo?.length) {
    const fedsPromoWrapper = createTag('div', { class: 'feds-promo-aside-wrapper' });
    header.before(fedsPromoWrapper);
    header.classList.add('has-promo');
  }
}

async function decorateIcons(area, config) {
  const icons = area.querySelectorAll('span.icon');
  if (icons.length === 0) return;
  const { base } = config;
  loadStyle(`${base}/features/icons/icons.css`);
  loadLink(`${base}/img/icons/icons.svg`, { rel: 'preload', as: 'fetch', crossorigin: 'anonymous' });
  const { default: loadIcons } = await import('../features/icons/icons.js');
  await loadIcons(icons, config);
}

export async function customFetch({ resource, withCacheRules }) {
  const options = {};
  if (withCacheRules) {
    const params = new URLSearchParams(window.location.search);
    options.cache = params.get('cache') === 'off' ? 'reload' : 'default';
  }
  return fetch(resource, options);
}

const findReplaceableNodes = (area) => {
  const regex = /{{(.*?)}}|%7B%7B(.*?)%7D%7D/g;
  const walker = document.createTreeWalker(area, NodeFilter.SHOW_ALL);
  const nodes = [];
  let node = walker.nextNode();
  while (node !== null) {
    let matchFound = false;
    if (node.nodeType === Node.TEXT_NODE) {
      matchFound = regex.test(node.nodeValue);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const { attributes } = node;
      for (let i = 0; i < attributes.length; i += 1) {
        const { value: attrValue } = attributes[i];
        if (regex.test(attrValue)) {
          matchFound = true;
        }
      }
    }
    if (matchFound) {
      nodes.push(node);
      regex.lastIndex = 0;
    }
    node = walker.nextNode();
  }
  return nodes;
};

let placeholderRequest;
export async function decoratePlaceholders(area, config) {
  if (!area) return;
  const nodes = findReplaceableNodes(area);
  if (!nodes.length) return;
  area.dataset.hasPlaceholders = 'true';
  const placeholderPath = `${config.locale?.contentRoot}/placeholders.json`;
  placeholderRequest = placeholderRequest
    || customFetch({ resource: placeholderPath, withCacheRules: true })
      .catch(() => ({}));
  const { decoratePlaceholderArea } = await import('../features/placeholders.js');
  await decoratePlaceholderArea({ placeholderPath, placeholderRequest, nodes });
}

async function loadFooter() {
  const footer = document.querySelector('footer');
  if (!footer) return;
  const footerMeta = getMetadata('footer');
  if (footerMeta === 'off') {
    footer.remove();
    return;
  }
  footer.className = footerMeta || 'global-footer';
  await loadBlock(footer);
}

export function filterDuplicatedLinkBlocks(blocks) {
  if (!blocks?.length) return [];
  const uniqueModalKeys = new Set();
  const uniqueBlocks = [];
  for (const obj of blocks) {
    if (obj.className.includes('modal')) {
      const key = `${obj.dataset.modalHash}-${obj.dataset.modalPath}`;
      if (!uniqueModalKeys.has(key)) {
        uniqueModalKeys.add(key);
        uniqueBlocks.push(obj);
      }
    } else {
      uniqueBlocks.push(obj);
    }
  }
  return uniqueBlocks;
}

function decorateSection(section, idx) {
  let links = decorateLinks(section);
  decorateDefaults(section);
  const blocks = section.querySelectorAll(':scope > div[class]:not(.content)');

  const { doNotInline } = getConfig();
  const blockLinks = [...blocks].reduce((blkLinks, block) => {
    const blockName = block.classList[0];
    links.filter((link) => block.contains(link))
      .forEach((link) => {
        if (link.classList.contains('fragment')
          && MILO_BLOCKS.includes(blockName) // do not inline consumer blocks (for now)
          && !doNotInline.includes(blockName)) {
          if (!link.href.includes('#_inline')) {
            link.href = `${link.href}#_inline`;
          }
          blkLinks.inlineFrags.push(link);
        } else if (link.classList.contains('link-block')) {
          blkLinks.autoBlocks.push(link);
        }
      });
    return blkLinks;
  }, { inlineFrags: [], autoBlocks: [] });

  const embeddedLinks = [...blockLinks.inlineFrags, ...blockLinks.autoBlocks];
  if (embeddedLinks.length) {
    links = links.filter((link) => !embeddedLinks.includes(link));
  }
  section.className = 'section';
  section.dataset.status = 'decorated';
  section.dataset.idx = idx;
  return {
    blocks: [...links, ...blocks],
    el: section,
    idx,
    preloadLinks: filterDuplicatedLinkBlocks(blockLinks.autoBlocks),
  };
}

function decorateSections(el, isDoc) {
  const selector = isDoc ? 'body > main > div' : ':scope > div';
  return [...el.querySelectorAll(selector)].map(decorateSection);
}

export async function decorateFooterPromo(doc = document) {
  const footerPromoTag = getMetadata('footer-promo-tag', doc);
  const footerPromoType = getMetadata('footer-promo-type', doc);
  if (!footerPromoTag && footerPromoType !== 'taxonomy') return;

  const { default: initFooterPromo } = await import('../features/footer-promo.js');
  await initFooterPromo(footerPromoTag, footerPromoType, doc);
}

const getMepValue = (val) => {
  const valMap = { on: true, off: false, postLCP: 'postlcp' };
  const finalVal = val?.toLowerCase().trim();
  if (finalVal in valMap) return valMap[finalVal];
  return finalVal;
};

const getMdValue = (key) => {
  const value = getMetadata(key);
  if (value) {
    return getMepValue(value);
  }
  return false;
};

const getPromoMepEnablement = () => {
  const mds = [
    'apac_manifestnames',
    'emea_manifestnames',
    'americas_manifestnames',
    'jp_manifestnames',
    'manifestnames',
  ];
  const mdObject = mds.reduce((obj, key) => {
    const val = getMdValue(key);
    if (val) {
      obj[key] = val;
    }
    return obj;
  }, {});
  if (Object.keys(mdObject).length) {
    return mdObject;
  }
  return false;
};

export const getMepEnablement = (mdKey, paramKey = false) => {
  const paramValue = PAGE_URL.searchParams.get(paramKey || mdKey);
  if (paramValue) return getMepValue(paramValue);
  if (PROMO_PARAM === paramKey) return getPromoMepEnablement();
  return getMdValue(mdKey);
};

let imsLoaded;
export async function loadIms() {
  imsLoaded = imsLoaded || new Promise((resolve, reject) => {
    const {
      locale, imsClientId, imsScope, env, base, adobeid, imsTimeout,
    } = getConfig();
    if (!imsClientId) {
      reject(new Error('Missing IMS Client ID'));
      return;
    }
    const [unavMeta, ahomeMeta] = [getMetadata('universal-nav')?.trim(), getMetadata('adobe-home-redirect')];
    const defaultScope = `AdobeID,openid,gnav${unavMeta && unavMeta !== 'off' ? ',pps.read,firefly_api,additional_info.roles,read_organizations,account_cluster.read' : ''}`;
    const timeout = setTimeout(() => reject(new Error('IMS timeout')), imsTimeout || 5000);
    window.adobeid = {
      client_id: imsClientId,
      scope: imsScope || defaultScope,
      locale: locale?.ietf?.replace('-', '_') || 'en_US',
      redirect_uri: ahomeMeta === 'on'
        ? `https://www${env.name !== 'prod' ? '.stage' : ''}.adobe.com${locale.prefix}` : undefined,
      autoValidateToken: true,
      environment: env.ims,
      useLocalStorage: false,
      onReady: () => {
        resolve();
        clearTimeout(timeout);
      },
      onError: reject,
      ...adobeid,
    };
    const path = PAGE_URL.searchParams.get('useAlternateImsDomain')
      ? 'https://auth.services.adobe.com/imslib/imslib.min.js'
      : `${base}/deps/imslib.min.js`;
    loadScript(path);
  }).then(() => {
    if (getMepEnablement('xlg') === 'loggedout') {
      /* c8 ignore next */
      getConfig().entitlements();
    } else if (!window.adobeIMS?.isSignedInUser()) {
      getConfig().entitlements([]);
    }
  }).catch((e) => {
    getConfig().entitlements([]);
    throw e;
  });

  return imsLoaded;
}

export async function loadMartech({
  persEnabled = false,
  persManifests = [],
  postLCP = false,
} = {}) {
  // eslint-disable-next-line no-underscore-dangle
  if (window.marketingtech?.adobe?.launch && window._satellite) {
    return true;
  }

  if (PAGE_URL.searchParams.get('martech') === 'off'
    || PAGE_URL.searchParams.get('marketingtech') === 'off'
    || getMetadata('martech') === 'off') {
    return false;
  }

  window.targetGlobalSettings = { bodyHidingEnabled: false };
  loadIms().catch(() => { });

  const { default: initMartech } = await import('../martech/martech.js');
  await initMartech({ persEnabled, persManifests, postLCP });
  isMartechLoaded = true;

  return true;
}

/**
 * Checks if the user is signed out based on the server timing and navigation performance.
 *
 * @returns {boolean} True if the user is signed out, otherwise false.
 */
function isSignedOut() {
  const serverTiming = window.performance?.getEntriesByType('navigation')?.[0]?.serverTiming?.reduce(
    (acc, { name, description }) => ({ ...acc, [name]: description }),
    {},
  );

  return !Object.keys(serverTiming || {}).length || serverTiming?.sis === '0';
}

/**
 * Enables personalization (V2) for the page.
 *
 * @returns {boolean} True if personalization is enabled, otherwise false.
 */
export function enablePersonalizationV2() {
  const enablePersV2 = getMepEnablement('personalization-v2');
  return !!enablePersV2 && isSignedOut();
}

async function checkForPageMods() {
  const {
    mep: mepParam,
    mepHighlight,
    mepButton,
    martech,
  } = Object.fromEntries(PAGE_URL.searchParams);
  let targetInteractionPromise = null;
  let calculatedTimeout = null;
  if (mepParam === 'off') return;
  const pzn = getMepEnablement('personalization');
  const promo = getMepEnablement('manifestnames', PROMO_PARAM);
  const target = martech === 'off' ? false : getMepEnablement('target');
  const xlg = martech === 'off' ? false : getMepEnablement('xlg');
  const ajo = martech === 'off' ? false : getMepEnablement('ajo');

  if (!(pzn || target || promo || mepParam
    || mepHighlight || mepButton || mepParam === '' || xlg || ajo)) return;

  const enablePersV2 = enablePersonalizationV2();
  const hybridPersEnabled = getMepEnablement('hybrid-pers');
  if ((target || xlg) && enablePersV2) {
    const params = new URL(window.location.href).searchParams;
    calculatedTimeout = parseInt(params.get('target-timeout'), 10)
      || parseInt(getMetadata('target-timeout'), 10)
      || TARGET_TIMEOUT_MS;

    const { locale } = getConfig();
    targetInteractionPromise = (async () => {
      const { loadAnalyticsAndInteractionData } = await import('../martech/helpers.js');
      const now = performance.now();
      performance.mark('interaction-start');
      const data = await loadAnalyticsAndInteractionData(
        { locale, env: getEnv({})?.name, calculatedTimeout, hybridPersEnabled },
      );
      performance.mark('interaction-end');
      performance.measure('total-time', 'interaction-start', 'interaction-end');
      const respTime = performance.getEntriesByName('total-time')[0];

      return { targetInteractionData: data, respTime, respStartTime: now };
    })();
  } else if ((target || xlg || ajo) && !isMartechLoaded) loadMartech();
  else if (pzn && martech !== 'off') {
    loadIms()
      .then(() => {
        /* c8 ignore next */
        if (window.adobeIMS?.isSignedInUser() && !isMartechLoaded) loadMartech();
      })
      .catch((e) => { console.log('Unable to load IMS:', e); });
  }

  const { init } = await import('../features/personalization/personalization.js');
  await init({
    mepParam,
    mepHighlight,
    mepButton,
    pzn,
    promo,
    target,
    ajo,
    targetInteractionPromise,
    calculatedTimeout,
    enablePersV2,
    hybridPersEnabled,
  });
}

async function loadPostLCP(config) {
  const { default: loadFavIcon } = await import('./favicon.js');
  loadFavIcon(createTag, getConfig(), getMetadata);
  await decoratePlaceholders(document.body.querySelector('header'), config);
  const sk = document.querySelector('aem-sidekick, helix-sidekick');
  if (sk) import('./sidekick-decorate.js').then((mod) => { mod.default(sk); });
  if (config.mep?.targetEnabled === 'postlcp') {
    /* c8 ignore next 2 */
    const { init } = await import('../features/personalization/personalization.js');
    await init({ postLCP: true });
    if (enablePersonalizationV2() && !isMartechLoaded) loadMartech();
  } else if (!isMartechLoaded) loadMartech();

  const georouting = getMetadata('georouting') || config.geoRouting;
  if (georouting === 'on') {
    const jsonPromise = fetch(`${config.contentRoot ?? ''}/georoutingv2.json`);
    import('../features/georoutingv2/georoutingv2.js')
      .then(({ default: loadGeoRouting }) => {
        loadGeoRouting(config, createTag, getMetadata, loadBlock, loadStyle, jsonPromise);
      });
  }
  const header = document.querySelector('header');
  if (header) {
    header.classList.add('gnav-hide');
    loadBlock(header);
    header.classList.remove('gnav-hide');
  }
  loadTemplate();
  const { default: loadFonts } = await import('./fonts.js');
  loadFonts(config.locale, loadStyle);

  if (config?.mep) {
    import('../features/personalization/personalization.js')
      .then(({ addMepAnalytics }) => addMepAnalytics(config, header));
  }
}

export function scrollToHashedElement(hash) {
  if (!hash || /=/.test(hash)) return; // skip if hash is used for deeplinking.
  const elementId = decodeURIComponent(hash).slice(1);
  let targetElement;
  try {
    targetElement = document.querySelector(`#${elementId}:not(.dialog-modal)`);
  } catch (e) {
    window.lana?.log(`Could not query element because of invalid hash - ${elementId}: ${e.toString()}`);
  }
  if (!targetElement) return;
  const bufferHeight = document.querySelector('.global-navigation')?.offsetHeight || 0;
  const topOffset = targetElement.getBoundingClientRect().top + window.pageYOffset;
  window.scrollTo({
    top: topOffset - bufferHeight,
    behavior: 'smooth',
  });
}

export async function loadDeferred(area, blocks, config) {
  area.dispatchEvent(new Event(MILO_EVENTS.DEFERRED));

  if (area !== document) {
    return;
  }

  config.resolveDeferred?.(true);

  if (config.links === 'on') {
    const path = `${config.contentRoot || ''}${getMetadata('links-path') || '/seo/links.json'}`;
    import('../features/links.js').then((mod) => mod.default(path, area));
  }

  if (config.locale?.ietf === 'ja-JP') {
    // Japanese word-wrap
    import('../features/japanese-word-wrap.js').then(({ default: controlJapaneseLineBreaks }) => {
      controlJapaneseLineBreaks(config, area);
    });
  }

  if (getMetadata('pageperf') === 'on') {
    import('./logWebVitals.js')
      .then((mod) => mod.default(getConfig().mep, {
        delay: getMetadata('pageperf-delay'),
        sampleRate: parseInt(getMetadata('pageperf-rate'), 10),
      }));
  }
  if (config.mep?.preview) {
    import('../features/personalization/preview.js')
      .then(({ default: decoratePreviewMode }) => decoratePreviewMode());
  }
  if (config?.dynamicNavKey && config?.env?.name !== 'prod') {
    const { miloLibs } = config;
    loadStyle(`${miloLibs}/features/dynamic-navigation/status.css`);
    const { default: loadDNStatus } = await import('../features/dynamic-navigation/status.js');
    loadDNStatus();
  }
}

function initSidekick() {
  const initPlugins = async () => {
    const { default: init } = await import('./sidekick.js');
    init({ createTag, loadBlock, loadScript, loadStyle });
  };

  if (document.querySelector('aem-sidekick, helix-sidekick')) {
    initPlugins();
  } else {
    document.addEventListener('sidekick-ready', () => {
      initPlugins();
    });
  }
}

function decorateMeta() {
  const { origin } = window.location;
  const contents = document.head.querySelectorAll('[content*=".hlx."], [content*=".aem."]');
  contents.forEach((meta) => {
    if (meta.getAttribute('property') === 'hlx:proxyUrl' || meta.getAttribute('name')?.endsWith('schedule')) return;
    try {
      const url = new URL(meta.content);
      const localizedLink = localizeLink(`${origin}${url.pathname}`);
      const localizedURL = localizedLink.includes(origin) ? localizedLink : `${origin}${localizedLink}`;
      meta.setAttribute('content', `${localizedURL}${url.search}${url.hash}`);
    } catch (e) {
      window.lana?.log(`Cannot make URL from metadata - ${meta.content}: ${e.toString()}`);
    }
  });

  // Event-based modal
  window.addEventListener('modal:open', async (e) => {
    const { miloLibs } = getConfig();
    const { findDetails, getModal } = await import('../blocks/modal/modal.js');
    loadStyle(`${miloLibs}/blocks/modal/modal.css`);
    const details = findDetails(e.detail.hash);
    if (details) getModal(details);
  });
}

function decorateDocumentExtras() {
  decorateMeta();
  decorateHeader();
}

async function documentPostSectionLoading(config) {
  decorateFooterPromo();
  if (getMetadata('seotech-structured-data') === 'on' || getMetadata('seotech-video-url')) {
    import('../features/seotech/seotech.js').then((module) => module.default(
      { locationUrl: window.location.href, getMetadata, createTag, getConfig },
    ));
  }
  const richResults = getMetadata('richresults');
  if (richResults) {
    const { default: addRichResults } = await import('../features/richresults.js');
    addRichResults(richResults, { createTag, getMetadata });
  }
  loadFooter();
  if (config.experiment?.selectedVariant?.scripts?.length) {
    config.experiment.selectedVariant.scripts.forEach((script) => loadScript(script));
  }
  initSidekick();

  const { default: delayed } = await import('../scripts/delayed.js');
  delayed([getConfig, getMetadata, loadScript, loadStyle, loadIms]);

  import('../martech/attributes.js').then((analytics) => {
    document.querySelectorAll('main > div').forEach((section, idx) => analytics.decorateSectionAnalytics(section, idx, config));
  });

  document.body.appendChild(createTag('div', { id: 'page-load-ok-milo', style: 'display: none;' }));
}

export function partition(arr, fn) {
  return arr.reduce(
    (acc, val, i, ar) => {
      acc[fn(val, i, ar) ? 0 : 1].push(val);
      return acc;
    },
    [[], []],
  );
}

const preloadBlockResources = (blocks = []) => blocks.map((block) => {
  if (block.classList.contains('hide-block')) return null;
  const { blockPath, hasStyles, name } = getBlockData(block);
  if (['marquee', 'hero-marquee'].includes(name)) {
    loadLink(`${getConfig().base}/utils/decorate.js`, { rel: 'preload', as: 'script', crossorigin: 'anonymous' });
  }
  loadLink(`${blockPath}.js`, { rel: 'preload', as: 'script', crossorigin: 'anonymous' });
  return hasStyles && new Promise((resolve) => { loadStyle(`${blockPath}.css`, resolve); });
}).filter(Boolean);

async function resolveInlineFrags(section) {
  const inlineFrags = [...section.el.querySelectorAll('a[href*="#_inline"]')];
  if (!inlineFrags.length) return;
  const { default: loadInlineFrags } = await import('../blocks/fragment/fragment.js');
  const fragPromises = inlineFrags.map((link) => loadInlineFrags(link));
  await Promise.all(fragPromises);
  const newlyDecoratedSection = decorateSection(section.el, section.idx);
  section.blocks = newlyDecoratedSection.blocks;
  section.preloadLinks = newlyDecoratedSection.preloadLinks;
}

async function processSection(section, config, isDoc) {
  await resolveInlineFrags(section);
  const firstSection = section.el.dataset.idx === '0';
  const stylePromises = firstSection ? preloadBlockResources(section.blocks) : [];
  preloadBlockResources(section.preloadLinks);
  await Promise.all([
    decoratePlaceholders(section.el, config),
    decorateIcons(section.el, config),
  ]);
  const loadBlocks = [...stylePromises];
  if (section.preloadLinks.length) {
    const [modals, blocks] = partition(section.preloadLinks, (block) => block.classList.contains('modal'));
    await Promise.all(blocks.map((block) => loadBlock(block)));
    modals.forEach((block) => loadBlock(block));
  }

  section.blocks.forEach((block) => loadBlocks.push(loadBlock(block)));

  // Only move on to the next section when all blocks are loaded.
  await Promise.all(loadBlocks);

  delete section.el.dataset.status;
  if (isDoc && firstSection) await loadPostLCP(config);
  delete section.el.dataset.idx;
  return section.blocks;
}

export async function loadArea(area = document) {
  const isDoc = area === document;

  if (isDoc) {
    await checkForPageMods();
    appendHtmlToCanonicalUrl();
    appendSuffixToTitles();
  }
  const config = getConfig();

  if (isDoc) {
    decorateDocumentExtras();
  }

  const sections = decorateSections(area, isDoc);

  const areaBlocks = [];
  for (const section of sections) {
    const sectionBlocks = await processSection(section, config, isDoc);
    areaBlocks.push(...sectionBlocks);

    areaBlocks.forEach((block) => {
      if (!block.className.includes('metadata')) block.dataset.block = '';
    });
  }

  const currentHash = window.location.hash;
  if (currentHash) {
    scrollToHashedElement(currentHash);
  }

  if (isDoc) await documentPostSectionLoading(config);

  await loadDeferred(area, areaBlocks, config);
}

export const utf8ToB64 = (str) => window.btoa(unescape(encodeURIComponent(str)));
export const b64ToUtf8 = (str) => decodeURIComponent(escape(window.atob(str)));

export function parseEncodedConfig(encodedConfig) {
  try {
    return JSON.parse(b64ToUtf8(decodeURIComponent(encodedConfig)));
  } catch (e) {
    console.log(e);
  }
  return null;
}

export function createIntersectionObserver({ el, callback, once = true, options = {} }) {
  const io = new IntersectionObserver((entries, observer) => {
    entries.forEach(async (entry) => {
      if (entry.isIntersecting) {
        if (once) observer.unobserve(entry.target);
        callback(entry.target, entry);
      }
    });
  }, options);
  io.observe(el);
  return io;
}

export function loadLana(options = {}) {
  if (window.lana) return;

  const lanaError = (e) => {
    window.lana?.log(e.reason || e.error || e.message, { errorType: 'i' });
  };

  window.lana = {
    log: async (...args) => {
      window.removeEventListener('error', lanaError);
      window.removeEventListener('unhandledrejection', lanaError);
      await import('./lana.js');
      return window.lana.log(...args);
    },
    debug: false,
    options,
  };

  window.addEventListener('error', lanaError);
  window.addEventListener('unhandledrejection', lanaError);
}

export const reloadPage = () => window.location.reload();
