// build/extract-utils.js
import * as parser from '@babel/parser';
import * as fs from 'fs';
import * as path from 'path';
import * as t from '@babel/types';
import traverseDefault from '@babel/traverse';
import generatorDefault from '@babel/generator';
import jsBeautify from 'js-beautify';

const traverse = traverseDefault.default || traverseDefault;
const generator = generatorDefault.default || generatorDefault;
const beautify = jsBeautify.js;

const HYDRATION_MARKER = '//@hydrate';

/**
 * Scans a directory recursively for files containing the hydration marker
 * @param {string} dir - Directory to scan
 * @returns {Array} Array of file paths that contain the hydration marker
 */
export function scanForHydratedFiles(dir) {
  const hydratedFiles = [];

  function scanDirectory(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes(HYDRATION_MARKER)) {
          hydratedFiles.push(fullPath);
        }
      }
    }
  }

  scanDirectory(dir);
  return hydratedFiles;
}

function convertHydrateString(inputStr) {
  const regex = /^@hydrate\({payload:\{(.*?)\}\}\)$/;
  const match = inputStr.match(regex);
  if (match && match[1] !== undefined) {
    return match[1];
  } else {
    return '';
  }
}

export function extractHandlers(outputPath, config, blocks) {
  const { entry } = config;
  const code = fs.readFileSync(entry, 'utf-8');
  const hydrationRuntime = fs.readFileSync('tools/hydration-runtime.js', 'utf-8');
  const ast = parser.parse(code, { sourceType: 'module', ranges: true, locations: true });
  const parts = entry.split('/');
  const lastTwoParts = parts.slice(-2).join('/');

  const dependencies = new Set();
  const componentHandlers = new Set();
  const importNodes = new Set();
  const hydrationCode = [];
  const extractedNodes = new Set();
  const processedDependencies = new Set();
  const globalVariables = new Set();
  const hydrateBlocks = [];

  let baseClassName = null;
  let newClassName = null;
  let classStartLine = null;

  traverse(ast, {
    enter(path) {
      const comments = path.node.leadingComments || [];

      const classComment = comments.find(c => c.value.trim().startsWith('@hydrate.class'));
      if (classComment && path.isClassDeclaration()) {
        const classHydrateRegex = /^@hydrate\.class\((\w+),\s*\{[\s\S]*?className:\s*["'](\w+)["']\s*\}\)/;
        const match = classHydrateRegex.exec(classComment.value.trim());
        if (match) {
          baseClassName = match[1];
          newClassName = match[2];
          classStartLine = path.node.loc.start.line;
        }
      }

      const hydrateComment = comments.find(c => c.value.trim().startsWith('@hydrate'));

      if (hydrateComment) {
        const lineNumber = path.node.loc?.start?.line || 0;
        const extractedPayload = convertHydrateString(hydrateComment.value);

        hydrateBlocks.push({
          code: `(${extractedPayload}) => {${generator(path.node, { comments: false }).code}}`,
          id: lineNumber
        });

        path.traverse({
          Identifier(innerPath) {
            dependencies.add(innerPath.node.name);
          }
        });
      }
    },

    VariableDeclarator(path) {
      if (path.parentPath.parentPath.isProgram()) {
        globalVariables.add(path.node.id.name);
      }
    }
  });

  let previousSize;
  do {
    previousSize = dependencies.size;
    const currentDeps = Array.from(dependencies);

    currentDeps.forEach(depName => {
      if (processedDependencies.has(depName)) return;
      processedDependencies.add(depName);

      traverse(ast, {
        FunctionDeclaration(path) {
          if (path.node.id.name === depName) {
            path.traverse({
              Identifier(innerPath) {
                dependencies.add(innerPath.node.name);
              }
            });
          }
        },

        VariableDeclarator(path) {
          if (
            path.node.id.name === depName &&
            path.parentPath.parentPath.isProgram() &&
            (path.node.init.type === 'FunctionExpression' ||
              path.node.init.type === 'ArrowFunctionExpression')
          ) {
            path.traverse({
              Identifier(innerPath) {
                dependencies.add(innerPath.node.name);
              }
            });
          }
        }
      });
    });
  } while (dependencies.size > previousSize);

  traverse(ast, {
    ImportDeclaration(path) {
      if (path.node.specifiers.some(spec => dependencies.has(spec.local.name))) {
        importNodes.add(path.node);
      }
    },
    FunctionDeclaration(path) {
      if (dependencies.has(path.node.id.name)) {
        extractedNodes.add(path.node);
      }
    },
    VariableDeclaration(path) {
      path.node.declarations.forEach(declaration => {
        if (
          t.isIdentifier(declaration.id) &&
          dependencies.has(declaration.id.name) &&
          globalVariables.has(declaration.id.name)
        ) {
          extractedNodes.add(path.node);
        }
      });
    }
  });

  blocks[lastTwoParts] = blocks[lastTwoParts] || [];
  blocks[lastTwoParts].push(...hydrateBlocks);

  const sortedStatements = [...importNodes, ...extractedNodes].map(node =>
    t.isExpression(node) ? t.expressionStatement(node) : node
  );

  const extractedAST = t.program(sortedStatements);
  let extractedCode = generator(extractedAST).code;

  const fnsArr = hydrateBlocks.map(blk => {
    return `_${blk.id}: ${blk.code}`;
  });

  if (baseClassName) {
    const seen = new Set();
    const methodBlocks = hydrateBlocks
      .filter(blk => {
        if (seen.has(blk.id)) return false;
        seen.add(blk.id);
        return !blk.code.includes('class ');
      })
      .map(blk => {
        const match = blk.code.match(/^\(\{?(.*?)\}?\)\s*=>\s*\{([\s\S]*)\}$/);
        if (!match) return '';
        const args = match[1].trim();
        const body = match[2].trim();
        return `  _${blk.id}({${args}}) {\n    ${body.replace(/\n/g, '\n    ')}\n  }`;
      })
      .filter(Boolean)
      .join('\n\n');

    if (methodBlocks.trim()) {
      const classCode = `
import ${baseClassName} from './${baseClassName}';
class ${baseClassName}Hydrate extends ${baseClassName} {
${methodBlocks}
}
      `;
      hydrationCode.push(beautify(classCode, { indent_size: 2 }));
    }
  } else {
    extractedCode = generator(t.program([...importNodes, ...extractedNodes])).code;
    hydrationCode.push(
      beautify(`
${extractedCode}
const hydrationToken = "${lastTwoParts}";
const hydrationBlocks = {${fnsArr.join(',')}};
${hydrationRuntime}
      `, { indent_size: 2 })
    );
  }

  fs.writeFileSync(outputPath, beautify(hydrationCode.join('\n'), { indent_size: 2 }));
}

/**
 * Process all hydrated files in a directory
 * @param {string} sourceDir - Directory containing files to process
 * @param {string} outputDir - Directory to output processed files
 * @param {object} blocks - Storage for block data
 */
export function processHydratedFiles(sourceDir, outputDir, blocks) {
  const hydratedFiles = scanForHydratedFiles(sourceDir);
  hydratedFiles.forEach(file => {
    const relativePath = path.relative(sourceDir, file);
    const outputPath = path.join(outputDir, relativePath);
    const config = { entry: file };
    extractHandlers(outputPath, config, blocks);
  });
}
