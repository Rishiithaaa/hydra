import { html, css, LitElement } from 'lit';

export class MerchMnemonicList extends LitElement {
    static styles = css`
        :host {
            display: flex;
            flex-wrap: nowrap;
            gap: 8px;
            margin-right: 16px;
            align-items: center;
        }

        ::slotted([slot='icon']) {
            display: flex;
            justify-content: center;
            align-items: center;
            height: max-content;
        }

        ::slotted([slot='description']) {
            font-size: 14px;
            line-height: 21px;
            margin: 0;
        }

        :host .hidden {
            display: none;
        }
    `;

    static properties = {
        description: { type: String, attribute: true },
    };

    constructor() {
        super();
    }

    render() {
        return html`
            <slot name="icon"></slot>
            <slot name="description">${this.description}</slot>
        `;
    }
}

customElements.define('merch-mnemonic-list', MerchMnemonicList);
