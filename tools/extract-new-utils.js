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

export function extractHandlers(outputPath, config) {
    const {entry} = config;
    const code = fs.readFileSync(entry, 'utf-8');
    const hydrate = fs.readFileSync('output.json', 'utf-8');
    const hydrationRuntime = fs.readFileSync('tools/hydration-runtime.js', 'utf-8');
    const ast = parser.parse(code, { sourceType: 'module', ranges: true });
    const parts = entry.split('/'); // Split by "/"
    const lastTwoParts = parts.slice(-2).join('/');
    const data = JSON.parse(hydrate);
    const hydrator = data.filter(obj => obj.file === lastTwoParts);
  
    const dependencies = new Set();
    const componentHandlers = new Set();
    const importNodes = new Set(); 
    const hydrationCode = [];
    const extractedNodes = new Set();
    const processedDependencies = new Set();
    const globalVariables = new Set();
    const hydrateBlocks = [];
  
    // AST Analysis
    traverse(ast, {
      enter(path) {
        const comments = path.node.leadingComments || [];
        const hydrateComment = comments.find(c => 
          c.value.trim().startsWith('@hydrate')
        );
  
        if (hydrateComment) {
          const id = hydrateComment.value.split('.')[1];
          
          hydrateBlocks.push({
            code: generator(path.node, { comments: false }).code,
            id: parseInt(id, 0)
          });
          path.traverse({
            Identifier(innerPath) {
                dependencies.add(innerPath.node.name);
            },
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
                // Track dependencies within this function
                path.traverse({
                  Identifier(innerPath) {
                    const name = innerPath.node.name;
                    // if (!isBrowserAPI(name) && globalVariables.has(name)) {
                    //   dependencies.add(name);
                    // }
                    if (!dependencies.has(innerPath.node.name)) {
                      dependencies.add(innerPath.node.name);
                    }
                  }
                });
              }
            },
            VariableDeclarator(path) {
              if (path.node.id.name === depName && 
                  path.parentPath.parentPath.isProgram() &&
                  (path.node.init.type === 'FunctionExpression' ||
                  path.node.init.type === 'ArrowFunctionExpression')) {
                // Track dependencies within function expressions
                path.traverse({
                  Identifier(innerPath) {
                    if (!dependencies.has(innerPath.node.name)) {
                      dependencies.add(innerPath.node.name);
                    }
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
              if (t.isIdentifier(declaration.id) && dependencies.has(declaration.id.name) &&  globalVariables.has(declaration.id.name)) {
                  extractedNodes.add(path.node);
              }
          });
        }
    });
  
    console.log(JSON.stringify(hydrateBlocks));
    console.log('-------')
    console.log(JSON.stringify(hydrator));
  
    const sortedStatements = [
        ...importNodes,
        ...extractedNodes,
    ].map(node => t.isExpression(node) ? t.expressionStatement(node) : node);
    const extractedAST = t.program(sortedStatements);
    const extractedCode = generator(extractedAST).code;
    hydrationCode.push(`
      ${extractedCode}
      ${hydrationRuntime}
    `)
    fs.writeFileSync(outputPath, beautify(hydrationCode.join('\n'), { indent_size: 2 }));
  }

/**
 * Process all hydrated files in a directory
 * @param {string} sourceDir - Directory containing files to process
 * @param {string} outputDir - Directory to output processed files
 */
export function processHydratedFiles(sourceDir, outputDir) {
    const hydratedFiles = scanForHydratedFiles(sourceDir);
    console.log(`Found ${hydratedFiles.length} files with hydration markers`);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    hydratedFiles.forEach(file => {
        const relativePath = path.relative(sourceDir, file);
        const outputPath = path.join(outputDir, `${path.basename(file, '.js')}-hydrate.js`);
        
        extractHandlers(outputPath, { entry: file });
        console.log(`Processed: ${relativePath}`);
    });
}


 // -------- Dynamic Hydration Runtime Code (ID Only) --------
     