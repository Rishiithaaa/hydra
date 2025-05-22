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
  const classHydrateBlocks = [];
  const nonClassHydrateBlocks = [];
  const hydratedClasses = new Map(); // key = classStartLine, value = { baseClassName, newClassName, blocks: [] }

traverse(ast, {
  enter(path) {
    const comments = path.node.leadingComments || [];

    const classComment = comments.find(c => c.value.trim().startsWith('@hydrate.class'));
    if (classComment && path.isClassDeclaration()) {
      const classHydrateRegex = /^@hydrate\.class\((\w+),\s*\{[\s\S]*?className:\s*["'](\w+)["']\s*\}\)/;
      const match = classHydrateRegex.exec(classComment.value.trim());
      if (match) {
        const baseClassName = match[1];
        const newClassName = match[2];
        const classStartLine = path.node.loc.start.line;

        hydratedClasses.set(classStartLine, {
          baseClassName,
          newClassName,
          blocks: [],
        });
      }
    }

    const hydrateComment = comments.find(c => c.value.trim().startsWith('@hydrate'));
    if (hydrateComment) {
      const lineNumber = path.node.loc?.start?.line || 0;
      const extractedPayload = convertHydrateString(hydrateComment.value);
      const hydrateCode = `(${extractedPayload}) => {${generator(path.node, { comments: false }).code}}`;

      const parentClass = path.findParent(p => p.isClassBody());
      if (parentClass) {
        const classNode = parentClass.parentPath.node;
        const classStartLine = classNode.loc.start.line;
        if (hydratedClasses.has(classStartLine)) {
          hydratedClasses.get(classStartLine).blocks.push({ code: hydrateCode, id: lineNumber });
        }
      } else if (!path.isClassDeclaration()) {
        nonClassHydrateBlocks.push({ code: hydrateCode, id: lineNumber });
      }

      path.traverse({
        Identifier(innerPath) {
          dependencies.add(innerPath.node.name);
        }
      });
    }

    // Clean comments
    if (path.node.leadingComments) {
      path.node.leadingComments = path.node.leadingComments.filter(comment =>
        !/^\s*@hydrate(\.class)?/.test(comment.value) && comment.value.trim() !== '@end'
      );
    }
    if (path.node.trailingComments) {
      path.node.trailingComments = path.node.trailingComments.filter(comment =>
        !/^\s*@hydrate(\.class)?/.test(comment.value) && comment.value.trim() !== '@end'
      );
    }

    if (path.isVariableDeclarator() && path.parentPath.parentPath.isProgram()) {
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

  const hydrateBlocks = [...classHydrateBlocks, ...nonClassHydrateBlocks];
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

 for (const { baseClassName, newClassName, blocks } of hydratedClasses.values()) {
  const seen = new Set();
  const methodBlocks = blocks
    .filter(blk => {
      if (seen.has(blk.id)) return false;
      seen.add(blk.id);
      return !blk.code.includes('class ');
    })
    .map(blk => {
      const methodMatch = blk.code.match(/^function\s+(\w+)\((.*?)\)\s*\{([\s\S]*)\}$/);
      if (methodMatch) {
        const name = methodMatch[1];
        const args = methodMatch[2];
        const body = methodMatch[3];
        return `${name}(${args}) {\n  ${body.replace(/\n/g, '\n  ')}\n}`;
      }

      const match = blk.code.match(/^\(\{?(.*?)\}?\)\s*=>\s*\{([\s\S]*)\}$/);
      if (!match) return '';
      const args = match[1].trim();
      const body = match[2].trim(); 
      return `_${blk.id}({${args}}) {\n  ${body.replace(/\n/g, '\n  ')}\n}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const methodDependencies = Array.from(extractedNodes)
    .map(node => generator(node).code)
    .join('\n');

  const classCode = `
import ${baseClassName} from './${baseClassName}';
class ${newClassName} extends ${baseClassName} {
${methodBlocks}
}
${methodDependencies}
;`;

  hydrationCode.push(beautify(classCode, { indent_size: 2 }));
}
 
if (nonClassHydrateBlocks.length > 0) {
  const hydrateFunctionNames = new Set();
  nonClassHydrateBlocks.forEach(blk => {
    const match = blk.code.match(/function\s+(\w+)/);
    if (match) hydrateFunctionNames.add(match[1]);
  });

  // Filter extractedNodes to remove functions with these names
  const filteredExtractedNodes = Array.from(extractedNodes).filter(node => {
    if (t.isFunctionDeclaration(node)) {
      return !hydrateFunctionNames.has(node.id.name);
    }
    return true;
  });

  const fnsArr = nonClassHydrateBlocks.map(blk => `_${blk.id}: ${blk.code}`);

  const nonClassCode = `
${generator(t.program([...importNodes, ...filteredExtractedNodes])).code}
const hydrationToken = "${lastTwoParts}";
const hydrationBlocks = {
  ${fnsArr.join(',\n  ')}
};
${hydrationRuntime}
;`;

  hydrationCode.push(beautify(nonClassCode, { indent_size: 2 }));
} else {
  extractedCode = generator(t.program([...importNodes, ...extractedNodes])).code;
  hydrationCode.push(
    beautify(
`${extractedCode}
const hydrationToken = "${lastTwoParts}";
const hydrationBlocks = {${fnsArr.join(',')}};
${hydrationRuntime}
`, { indent_size: 2 })
  );
}
const cleanedOutput = hydrationCode.join('\n')
  .replace(/\/\/\s*@hydrate(\.class)?\([^)]*\)\n?/g, '')
  .replace(/\/\/\s*@end\n?/g, '');

fs.writeFileSync(outputPath, beautify(cleanedOutput, { indent_size: 2 }));
}


/**
 * Process all hydrated files in a directory
 * @param {string} sourceDir - Directory containing files to process
 * @param {string} outputDir - Directory to output processed files
 * @param {object} blocks - Storage for block data
 */
export function processHydratedFiles(sourceDir, outputDir, blocks) {
    const hydratedFiles = scanForHydratedFiles(sourceDir);
    console.log(`Found ${hydratedFiles.length} files with hydration markers`);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    hydratedFiles.forEach(file => {
        const relativePath = path.relative(sourceDir, file);
        const outputPath = path.join(outputDir, `${path.basename(file, '.js')}-hydrate.js`);
        
        extractHandlers(outputPath, { entry: file }, blocks);
        console.log(`Processed: ${relativePath}`);
    });
}
