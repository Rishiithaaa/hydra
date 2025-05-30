import { html, LitElement } from 'lit';
import { MatchMediaController } from '@spectrum-web-components/reactive-controllers/src/MatchMedia.js';
import { deeplink, pushState } from './deeplink.js';
import { EVENT_MERCH_SIDENAV_SELECT } from './constants.js';

import {
    EVENT_MERCH_CARD_COLLECTION_SORT,
    EVENT_MERCH_CARD_COLLECTION_SHOWMORE,
    EVENT_AEM_ERROR,
    EVENT_AEM_LOAD,
} from './constants.js';
import { TABLET_DOWN } from './media.js';
import { styles } from './merch-card-collection.css.js';
import { getSlotText } from './utils.js';
import './mas-commerce-service';

const MERCH_CARD_COLLECTION = 'merch-card-collection';
const MERCH_CARD_COLLECTION_LOAD_TIMEOUT = 10000;

const SORT_ORDER = {
    alphabetical: 'alphabetical',
    authored: 'authored',
};

const VARIANT_CLASSES = {
    catalog: ['four-merch-cards'],
    plans: ['four-merch-cards'],
}

const RESULT_TEXT_SLOT_NAMES = {
    // no search
    filters: ['noResultText', 'resultText', 'resultsText'],
    // search on mobile
    mobile: [
        'noSearchResultsMobileText',
        'searchResultMobileText',
        'searchResultsMobileText',
    ],
    // search on desktop
    desktop: ['noSearchResultsText', 'searchResultText', 'searchResultsText'],
};

export const updateLiterals = (el, values = {}) => {
    el.querySelectorAll('span[data-placeholder]').forEach((el) => {
        const { placeholder } = el.dataset;
        el.innerText = values[placeholder] ?? '';
    });
};

const categoryFilter = (elements, { filter }) =>
    elements.filter((element) => element.filters.hasOwnProperty(filter));

const typeFilter = (elements, { types }) => {
    if (!types) return elements;
    types = types.split(',');
    return elements.filter((element) =>
        types.some((type) => element.types.includes(type)),
    );
};

const alphabeticalSorter = (elements) =>
    elements.sort((a, b) =>
        (a.title ?? '').localeCompare(b.title ?? '', 'en', {
            sensitivity: 'base',
        }),
    );

const authoredSorter = (elements, { filter }) =>
    elements.sort((a, b) => {
        if (
            b.filters[filter]?.order == undefined ||
            isNaN(b.filters[filter]?.order)
        )
            return -1;
        if (
            a.filters[filter]?.order == undefined ||
            isNaN(a.filters[filter]?.order)
        )
            return 1;
        return a.filters[filter].order - b.filters[filter].order;
    });

const searcher = (elements, { search }) => {
    if (search?.length) {
        search = search.toLowerCase();
        return elements.filter((element) => {
            const haystack = (element.title ?? '').toLowerCase();
            return haystack.includes(search);
        });
    }
    return elements;
};

export class MerchCardCollection extends LitElement {
    static properties = {
        filter: { type: String, attribute: 'filter', reflect: true },
        filtered: { type: String, attribute: 'filtered' }, // freeze filter
        search: { type: String, attribute: 'search', reflect: true },
        sort: {
            type: String,
            attribute: 'sort',
            default: SORT_ORDER.authored,
            reflect: true,
        },
        types: { type: String, attribute: 'types', reflect: true },
        limit: { type: Number, attribute: 'limit' },
        page: { type: Number, attribute: 'page', reflect: true },
        singleApp: { type: String, attribute: 'single-app', reflect: true },
        hasMore: { type: Boolean },
        displayResult: { type: Boolean, attribute: 'display-result' },
        resultCount: {
            type: Number,
        },
        sidenav: { type: Object },
    };

    mobileAndTablet = new MatchMediaController(this, TABLET_DOWN);

    constructor() {
        super();
        // set defaults
        this.filter = 'all';
        this.hasMore = false;
        this.resultCount = undefined;
        this.displayResult = false;
        this.data = null;
        this.variant = null;
        this.hydrating = false;
        this.hydrationReady = null;
    }

    render() {
        return html`${this.header}
            <slot></slot>
            ${this.footer}`;
    }

    checkReady() {
        const aemFragment = this.querySelector('aem-fragment');
        if (!aemFragment) return Promise.resolve(true);
        const timeoutPromise = new Promise((resolve) =>
            setTimeout(() => resolve(false), MERCH_CARD_COLLECTION_LOAD_TIMEOUT),
        );
        const hydration = async () => {
            await aemFragment.updateComplete;
            await this.hydrationReady;
            return true;
        }
        return Promise.race([hydration(), timeoutPromise])
    }

    updated(changedProperties) {
        // cards are not added yet.
        if (!this.querySelector('merch-card')) return;
        let lastScrollTop =
            window.scrollY || document.documentElement.scrollTop;

        const children = [...this.children].filter(
            (child) => child.tagName === 'MERCH-CARD',
        );

        if (children.length === 0) return;

        if (changedProperties.has('singleApp') && this.singleApp) {
            children.forEach((card) => {
                card.updateFilters(card.name === this.singleApp);
            });
        }

        const sorter =
            this.sort === SORT_ORDER.alphabetical
                ? alphabeticalSorter
                : authoredSorter;
        const reducers = [categoryFilter, typeFilter, searcher, sorter];

        let result = reducers
            .reduce((elements, reducer) => reducer(elements, this), children)
            .map((element, index) => [element, index]);

        this.resultCount = result.length;
        if (this.page && this.limit) {
            const pageSize = this.page * this.limit;
            this.hasMore = result.length > pageSize;
            result = result.filter(([, index]) => index < pageSize);
        }
        let reduced = new Map(result.reverse());
        for (const card of reduced.keys()) {
          this.prepend(card);
        }
        
        children.forEach((child) => {
            if (reduced.has(child)) {
                child.size = child.filters[this.filter]?.size;
                child.style.removeProperty('display');
                child.requestUpdate();
            } else {
                child.style.display = 'none';
                child.size = undefined;
            }
        });
        window.scrollTo(0, lastScrollTop);

        this.updateComplete.then(() => {
            // first child element of #resultText > slot
            const resultTextElement = this.shadowRoot
                .getElementById('resultText')
                ?.firstElementChild?.assignedElements?.()?.[0];
            if (!resultTextElement) return;

            this.sidenav?.filters?.addEventListener(EVENT_MERCH_SIDENAV_SELECT, () => {
              updateLiterals(resultTextElement, {
                resultCount: this.resultCount,
                searchTerm: this.search,
                filter: this.sidenav?.filters.selectedText,
              });
            });

            updateLiterals(resultTextElement, {
                resultCount: this.resultCount,
                searchTerm: this.search,
                filter: this.sidenav?.filters.selectedText,
            });
        });
    }

    connectedCallback() {
        super.connectedCallback();
        if (this.filtered) {
            this.filter = this.filtered;
            this.page = 1;
        } else {
            this.startDeeplink();
        }
        this.sidenav = document.querySelector('merch-sidenav');
        this.hydrate();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this.stopDeeplink?.();
    }

    async hydrate() {
        if (this.hydrating) return false;

        const aemFragment = this.querySelector('aem-fragment');
        if (!aemFragment) return;

        this.hydrating = true;
        let resolveHydration;
        this.hydrationReady = new Promise((resolve) => {
            resolveHydration = resolve;
        });

        function normalizePayload(fragment) {
            const payload = { cards: [], hierarchy: [], placeholders: fragment.placeholders };

            function traverseReferencesTree(root, references) {
                for (const reference of references) {
                    if (reference.fieldName === 'cards') {
                        if (payload.cards.findIndex(card => card.id === reference.identifier) !== -1) continue;
                        payload.cards.push(fragment.references[reference.identifier].value);
                        continue;
                    }
                    const { fields } = fragment.references[reference.identifier].value;
                    const collection = {
                        label: fields.label,
                        icon: fields.icon,
                        cards: fields.cards,
                        collections: []
                    };
                    root.push(collection);
                    traverseReferencesTree(collection.collections, reference.referencesTree);
                }
            }
            traverseReferencesTree(payload.hierarchy, fragment.referencesTree);
            
            return payload;
        }
        
        aemFragment.addEventListener(EVENT_AEM_ERROR, (event) => {
            console.error(event.detail);
            this.hydrating = false;
            aemFragment.remove();
        });
        aemFragment.addEventListener(EVENT_AEM_LOAD, async (event) => {
            this.data = normalizePayload(event.detail);
            const { cards, hierarchy } = this.data;
            aemFragment.cache.add(...cards);
            for (const fragment of cards) {
                const merchCard = document.createElement('merch-card');
                merchCard.setAttribute('consonant', '');
                merchCard.setAttribute('style', '');
                merchCard.filters = {};

                function populateFilters(level) {
                    for (const node of level) {
                        const index = node.cards.indexOf(fragment.id);
                        if (index === -1) continue;
                        const name = node.label.toLowerCase();
                        merchCard.filters[name] = { order: index + 1, size: fragment.fields.size };
                        populateFilters(node.collections);
                    }
                }
                populateFilters(hierarchy);

                const mcAemFragment = document.createElement('aem-fragment');
                mcAemFragment.setAttribute('fragment', fragment.id);
                merchCard.append(mcAemFragment);

                this.append(merchCard);
            }

            const variant = cards[0]?.fields.variant;
            this.variant = variant;
            this.classList.add('merch-card-collection', variant, ...(VARIANT_CLASSES[variant] || []));

            this.displayResult = true;
            this.hydrating = false;
            aemFragment.remove();
            resolveHydration();
        });
    }

    get header() {
        if (this.filtered) return;
        return html`<div id="header">
                <sp-theme  color="light" scale="medium">
                    ${this.searchBar} ${this.filtersButton} ${this.sortButton}
                </sp-theme>
            </div>
            <div id="resultText" aria-live="polite">
                ${this.displayResult
                    ? html`<slot name="${this.resultTextSlotName}"></slot>`
                    : ''}
            </div>`;
    }

    get footer() {
        if (this.filtered) return;
        return html`<div id="footer">
            <sp-theme  color="light" scale="medium">
                ${this.showMoreButton}
            </sp-theme>
        </div>`;
    }

    get resultTextSlotName() {
        const slotName =
            RESULT_TEXT_SLOT_NAMES[
                this.search
                    ? this.mobileAndTablet.matches
                        ? 'mobile'
                        : 'desktop'
                    : 'filters'
            ][Math.min(this.resultCount, 2)];

        return slotName;
    }

    get showMoreButton() {
        if (!this.hasMore) return;
        return html`<sp-button
            variant="secondary"
            treatment="outline"
            style="order: 1000;"
            @click="${this.showMore}"
        >
            <slot name="showMoreText"></slot>
        </sp-button>`;
    }

    get filtersButton() {
        return this.sidenav && this.mobileAndTablet.matches
            ? html`<sp-action-button
                  id="filtersButton"
                  variant="secondary"
                  treatment="outline"
                  @click="${this.openFilters}"
                  ><slot name="filtersText"></slot
              ></sp-action-button>`
            : '';
    }

    get searchBar() {
        const searchPlaceholder = getSlotText(this, 'searchText');
        return searchPlaceholder && this.mobileAndTablet.matches
            ? html`<merch-search deeplink="search">
                  <sp-search
                      id="searchBar"
                      @submit="${this.searchSubmit}"
                      placeholder="${searchPlaceholder}"
                  ></sp-search>
              </merch-search>`
            : '';
    }

    get sortButton() {
        const sortText = getSlotText(this, 'sortText');
        const popularityText = getSlotText(this, 'popularityText');
        const alphabeticallyText = getSlotText(this, 'alphabeticallyText');

        if (!(sortText && popularityText && alphabeticallyText)) return;
        const alphabetical = this.sort === SORT_ORDER.alphabetical;

        return html`
            <sp-action-menu
                id="sortButton"
                size="m"
                @change="${this.sortChanged}"
                selects="single"
                value="${alphabetical
                    ? SORT_ORDER.alphabetical
                    : SORT_ORDER.authored}"
            >
                <span slot="label-only"
                    >${sortText}:
                    ${alphabetical ? alphabeticallyText : popularityText}</span
                >
                <sp-menu-item value="${SORT_ORDER.authored}"
                    >${popularityText}</sp-menu-item
                >
                <sp-menu-item value="${SORT_ORDER.alphabetical}"
                    >${alphabeticallyText}</sp-menu-item
                >
            </sp-action-menu>
        `;
    }

    sortChanged(event) {
        if (event.target.value === SORT_ORDER.authored) {
            pushState({ sort: undefined });
        } else {
            pushState({ sort: event.target.value });
        }

        this.dispatchEvent(
            new CustomEvent(EVENT_MERCH_CARD_COLLECTION_SORT, {
                bubbles: true,
                composed: true,
                detail: {
                    value: event.target.value,
                },
            }),
        );
    }

    async showMore() {
        this.dispatchEvent(
            new CustomEvent(EVENT_MERCH_CARD_COLLECTION_SHOWMORE, {
                bubbles: true,
                composed: true,
            }),
        );
        const page = this.page + 1;
        pushState({ page });
        this.page = page;
        await this.updateComplete;
    }

    startDeeplink() {
        this.stopDeeplink = deeplink(
            ({ category, filter, types, sort, search, single_app, page }) => {
                filter = filter || category;
                if (!this.filtered && filter && filter !== this.filter) {
                    // a filter has changed, reset page to 1.
                    setTimeout(() => {
                        pushState({ page: undefined });
                        this.page = 1;
                    }, 1);
                }
                if (!this.filtered) {
                    this.filter = filter ?? this.filter;
                }
                this.types = types ?? '';
                this.search = search ?? '';
                this.singleApp = single_app;
                this.sort = sort;
                this.page = Number(page) || 1;
            },
        );
    }

    openFilters(e) {
        this.sidenav?.showModal(e);
    }

    static styles = [styles];
}

MerchCardCollection.SortOrder = SORT_ORDER;

customElements.define(MERCH_CARD_COLLECTION, MerchCardCollection);
