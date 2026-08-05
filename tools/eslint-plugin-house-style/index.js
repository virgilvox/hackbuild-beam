/*
 * House style, enforced.
 *
 * Both original PRDs stated the no-dash no-emoji rule in prose and one of them
 * observed that prose does not hold: "house style is a build failure, not a review
 * comment". This is that build failure. It covers string literals, template
 * chunks, JSX text and every comment, because UI copy and the paragraphs that
 * explain a paid-for constant are exactly the places the rule keeps slipping.
 */

const EM_DASH = "—";
const EN_DASH = "–";
const HORIZONTAL_BAR = "―";
const FIGURE_DASH = "‒";

const DASHES = [
  [EM_DASH, "em dash"],
  [EN_DASH, "en dash"],
  [HORIZONTAL_BAR, "horizontal bar"],
  [FIGURE_DASH, "figure dash"],
];

/*
 * Pictographic ranges only. This deliberately does not match every symbol with an
 * Emoji property: characters like the degree sign and the plus-minus sign are
 * legitimate instrument text and banning them would be a nuisance in a UI whose
 * whole job is reporting angles.
 */
const EMOJI = /\p{Extended_Pictographic}/u;

function scan(text) {
  const hits = [];
  for (const [ch, label] of DASHES) {
    if (text.includes(ch)) hits.push(label);
  }
  return hits;
}

const noDashes = {
  meta: {
    type: "problem",
    docs: { description: "Ban em dashes and en dashes in source, comments and UI copy." },
    schema: [],
    messages: {
      found:
        "House style: no {{kind}}. Use a plain ASCII hyphen, a comma, or two sentences.",
    },
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();

    function report(node, text) {
      for (const kind of scan(text)) {
        context.report({ node, messageId: "found", data: { kind } });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.raw);
      },
      JSXText(node) {
        report(node, node.value);
      },
      "Program:exit"() {
        for (const comment of source.getAllComments()) {
          report(comment, comment.value);
        }
      },
    };
  },
};

const noEmoji = {
  meta: {
    type: "problem",
    docs: { description: "Ban emoji everywhere. Icons are inline SVG." },
    schema: [],
    messages: {
      found: "House style: no emoji. Icons are inline SVG.",
    },
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();

    function report(node, text) {
      if (EMOJI.test(text)) context.report({ node, messageId: "found" });
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.raw);
      },
      JSXText(node) {
        report(node, node.value);
      },
      "Program:exit"() {
        for (const comment of source.getAllComments()) {
          report(comment, comment.value);
        }
      },
    };
  },
};

export default {
  meta: { name: "eslint-plugin-house-style", version: "0.1.0" },
  rules: {
    "no-dashes": noDashes,
    "no-emoji": noEmoji,
  },
};
