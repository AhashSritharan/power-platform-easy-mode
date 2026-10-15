// FetchXML for the fake org: evaluates a <fetch> against in-memory rows and
// answers in a live org's shape (copied from a real response): only the
// requested columns, nulls left out, lookups as _x_value with their
// annotations, @odata.count / totalrecordcount when asked, and a
// fetchxmlpagingcookie + morerecords while there are more pages.
//
// Covers what the tools send: attributes, nested and/or filters, the
// condition operators below, several orders, count/page. A link-entity, or an
// operator not listed, throws — the test then says what the tool asked for
// rather than getting a silently wrong answer.

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** A tiny XML reader: { name, attrs, children } for each element. */
export function parseXml(xml) {
    const root = { name: '#root', attrs: {}, children: [] };
    const stack = [root];
    const re = /<(\/?)([\w:-]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
        const [, closing, name, rawAttrs, selfClosing, text] = m;
        if (text !== undefined) {
            if (text.trim()) stack.at(-1).children.push({ name: '#text', text: unescape(text) });
            continue;
        }
        if (closing) { stack.pop(); continue; }
        const attrs = {};
        for (const a of rawAttrs.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = unescape(a[2]);
        const node = { name, attrs, children: [] };
        stack.at(-1).children.push(node);
        if (!selfClosing) stack.push(node);
    }
    return root.children[0];
}

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const elements = (node, name) => node.children.filter((c) => c.name === name);

/** A column's value on a row, the way FetchXML names it. */
function valueOf(row, attribute) {
    if (attribute in row) return row[attribute];
    if (`_${attribute}_value` in row) return row[`_${attribute}_value`];
    // A lookup's name column ("parentcustomeridname") is the lookup's formatted value.
    const lookup = attribute.endsWith('name') ? `_${attribute.slice(0, -4)}_value` : null;
    if (lookup && lookup in row) return row[`${lookup}${FORMATTED}`] ?? null;
    return null;
}

const likeToRegExp = (pattern) => new RegExp(`^${pattern
    .replace(/\[(.)\]|([%_])|([.*+?^${}()|\\/])/g, (all, literal, wild, special) => {
        if (literal !== undefined) return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (wild) return wild === '%' ? '.*' : '.';
        return `\\${special}`;
    })}$`, 'is');

const day = (v) => String(v ?? '').slice(0, 10);
const norm = (v) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : v);
// eslint-disable-next-line eqeqeq
const same = (a, b) => (typeof a === 'boolean' ? a === (b === '1' || b === 'true' || b === true) : norm(a) == norm(b));

function conditionPredicate(node, ctx) {
    const { attribute, operator } = node.attrs;
    const value = node.attrs.value;
    const values = elements(node, 'value').map((v) => v.children[0]?.text ?? '');
    const get = (row) => valueOf(row, attribute);
    switch (operator) {
        case 'eq': return (row) => same(get(row), value);
        case 'ne': return (row) => !same(get(row), value);
        case 'null': return (row) => get(row) === null || get(row) === undefined;
        case 'not-null': return (row) => get(row) !== null && get(row) !== undefined;
        case 'like': return (row) => likeToRegExp(value).test(String(get(row) ?? ''));
        case 'not-like': return (row) => !likeToRegExp(value).test(String(get(row) ?? ''));
        case 'gt': return (row) => get(row) > value;
        case 'ge': return (row) => get(row) >= value;
        case 'lt': return (row) => get(row) < value;
        case 'le': return (row) => get(row) <= value;
        case 'on': return (row) => day(get(row)) === day(value);
        case 'on-or-after': return (row) => day(get(row)) >= day(value);
        case 'on-or-before': return (row) => day(get(row)) <= day(value);
        case 'in': return (row) => values.some((v) => same(get(row), v));
        case 'not-in': return (row) => !values.some((v) => same(get(row), v));
        case 'eq-userid': return (row) => same(get(row), ctx.userId);
        case 'contain-values': return (row) => String(get(row) ?? '').split(',').some((v) => values.includes(v.trim()));
        case 'not-contain-values': return (row) => !String(get(row) ?? '').split(',').some((v) => values.includes(v.trim()));
        default: throw new Error(`the fake's FetchXML has no operator "${operator}"`);
    }
}

function filterPredicate(node, ctx) {
    const parts = node.children.filter((c) => c.name !== '#text').map((child) => {
        if (child.name === 'condition') return conditionPredicate(child, ctx);
        if (child.name === 'filter') return filterPredicate(child, ctx);
        throw new Error(`unexpected <${child.name}> in a filter`);
    });
    return node.attrs.type === 'or'
        ? (row) => parts.some((p) => p(row))
        : (row) => parts.every((p) => p(row));
}

/** The response to a FetchXML query over `rows` — see the header. */
export function runFetchXml(fetchXml, rows, { primaryId, userId = null } = {}) {
    const fetch = parseXml(fetchXml);
    const entity = elements(fetch, 'entity')[0];
    if (elements(entity, 'link-entity').length) throw new Error('the fake\'s FetchXML has no link-entity support');

    let out = rows;
    for (const filter of elements(entity, 'filter')) out = out.filter(filterPredicate(filter, { userId }));

    const orders = elements(entity, 'order').map((o) => ({ attribute: o.attrs.attribute, sign: o.attrs.descending === 'true' ? -1 : 1 }));
    if (orders.length) {
        out = [...out].sort((a, b) => {
            for (const { attribute, sign } of orders) {
                const x = valueOf(a, attribute) ?? '';
                const y = valueOf(b, attribute) ?? '';
                if (x < y) return -sign;
                if (x > y) return sign;
            }
            return 0;
        });
    }

    const total = out.length;
    const count = Number(fetch.attrs.count) || 5000;
    const page = Number(fetch.attrs.page) || 1;
    const pageRows = out.slice((page - 1) * count, page * count);
    const more = page * count < total;

    const all = elements(entity, 'all-attributes').length > 0;
    const wanted = elements(entity, 'attribute').map((a) => a.attrs.name);
    const value = pageRows.map((row) => {
        const result = {};
        for (const [key, v] of Object.entries(row)) {
            const base = key.split('@')[0];
            const name = base.replace(/^_(.*)_value$/, '$1');
            const keep = all || key.startsWith('@odata') || wanted.includes(base) || wanted.includes(name) || base === primaryId;
            if (!keep) continue;
            if (!key.includes('@') && (v === null || v === undefined)) continue;
            result[key] = v;
        }
        return result;
    });

    const response = {};
    if (fetch.attrs.returntotalrecordcount === 'true') {
        response['@odata.count'] = total;
        response['@Microsoft.Dynamics.CRM.totalrecordcount'] = total;
        response['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] = false;
    }
    if (more) {
        const cookie = encodeURIComponent(encodeURIComponent(`<cookie page="${page}"></cookie>`));
        response['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'] = `<cookie pagenumber="${page + 1}" pagingcookie="${cookie}" istracking="False" />`;
    }
    response['@Microsoft.Dynamics.CRM.morerecords'] = more;
    response.value = value;
    return response;
}
