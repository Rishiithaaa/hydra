// build/extract-utils.js
import * as parser from '@babel/parser';
import * as fs from 'fs';
import * as t from '@babel/types';
import traverseDefault from '@babel/traverse';
import generatorDefault from '@babel/generator';
import jsBeautify from 'js-beautify';

const traverse = traverseDefault.default || traverseDefault;
const generator = generatorDefault.default || generatorDefault;
const beautify = jsBeautify.js;

export function extractHandlers(outputPath, config) {
  const {entry} = config;
  const code = fs.readFileSync(entry, 'utf-8');
  const hydrate = fs.readFileSync('output.json', 'utf-8');
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
    // -------- Dynamic Hydration Runtime Code (ID Only) --------
    
    /**
     * Performs client-side hydration dynamically at runtime using only 'id'.
     * Processes raw hydration data collected during SSR, finds corresponding
     * code block definition using 'id', resolves elements, and executes the code.
     * Replaces build-time generation of individual init_X functions.
     *
     * @param {Array<object>} rawHydratorData Raw hydration data array from SSR.
     * Example element: {id: 0, elements: {param1: "sh-id"}, data: {param3: "value"}}
     * @param {Array<object>} blockDefinitions Array defining hydration code blocks.
     * Example element: {id: 0, code: "console.log(param1);"}
     * 'id' must uniquely identify a code block in this version.
     */
    function hydrateDynamicallyById(rawHydratorData, blockDefinitions) {
      // 1. Validate Inputs
      if (!Array.isArray(rawHydratorData)) {
        console.error("Dynamic Hydration (ID Only) failed: rawHydratorData must be an array.", rawHydratorData);
        return;
      }
      if (!Array.isArray(blockDefinitions)) {
         console.error("Dynamic Hydration (ID Only) failed: blockDefinitions must be an array.", blockDefinitions);
        return;
      }
       if (rawHydratorData.length === 0) {
        console.log("No raw hydration data found.");
        return;
      }
       if (blockDefinitions.length === 0) {
        console.log("No hydration block definitions found.");
        return;
      }
    
      console.log(\`Starting dynamic hydration (ID Only). Found \${rawHydratorData.length} raw tasks and \${blockDefinitions.length} block definitions.\`);
    
      // Create a map from blockDefinitions using only ID for faster lookups
      const blockMap = new Map();
      blockDefinitions.forEach(def => {
          // Check if definition has required fields (id and code)
          if (def && def.id !== undefined && typeof def.code === 'string') {
              const blockId = def.id; // Use ID as the key
              if (blockMap.has(blockId)) {
                   // Warn about duplicates but allow last one to win
                   console.warn(\`Duplicate block definition found for id: \${blockId}. Last definition will be used.\`);
              }
              blockMap.set(blockId, def.code);
          } else {
               console.warn("Invalid block definition encountered during map creation (missing id or code):", def);
          }
      });
    
      if (blockMap.size === 0) {
          console.error("No valid block definitions were processed into the lookup map. Cannot proceed.");
          return;
      }
    
      // 2. Process each raw hydration task instance from SSR
      rawHydratorData.forEach((rawTask, taskIndex) => {
        // Validate raw task structure needed for processing (only need id)
        if (!rawTask || typeof rawTask !== 'object' || rawTask.id === undefined) {
           console.warn(\`Skipping invalid raw hydration task at index \${taskIndex} (missing id):\`, rawTask);
           return;
        }
    
        // Find the corresponding code string using only the ID
        const blockId = rawTask.id;
        const blockCodeString = blockMap.get(blockId);
    
        // Skip if no code found for this task's block definition ID
        if (blockCodeString === undefined) {
           console.warn(\`No code definition found for block id "\${blockId}" (Task index \${taskIndex}). Skipping task.\`);
           return;
        }
    
        // console.log(\`Processing task instance \${taskIndex} for block id \${blockId}\`); // Optional debug log
    
        try {
          const resolvedArgs = {}; // Holds resolved elements and data for this instance
    
          // 3. Resolve DOM Elements for this task instance
          const rawElements = rawTask.elements || {};
          for (const key in rawElements) {
            const idOrIds = rawElements[key];
            let selector = null;
            let isMultiple = false;
    
            if (Array.isArray(idOrIds)) {
               if (idOrIds.length > 0) {
                    selector = idOrIds
                        .map(mId => typeof mId === 'string' ? \`[data-hydrate-multi="\${mId}"]\` : null)
                        .filter(s => s !== null)
                        .join(',');
                    isMultiple = true;
                    if (!selector) {
                         console.warn(\`Dynamic Hydration (ID: \${blockId}, Task: \${taskIndex}, Key: \${key}): No valid multi-IDs found in array:\`, idOrIds);
                         resolvedArgs[key] = document.querySelectorAll(\`.non-existent-class-\${Date.now()}\`);
                         continue;
                    }
               } else {
                    console.warn(\`Dynamic Hydration (ID: \${blockId}, Task: \${taskIndex}, Key: \${key}): Empty array provided for multi-element IDs.\`);
                    resolvedArgs[key] = document.querySelectorAll(\`.non-existent-class-\${Date.now()}\`);
                    continue;
               }
            } else if (typeof idOrIds === 'string' && idOrIds.startsWith('sh-')) {
               selector = \`[data-hydrate-id="\${idOrIds}"]\`;
               isMultiple = false;
            } else {
               console.warn(\`Dynamic Hydration (ID: \${blockId}, Task: \${taskIndex}, Key: \${key}): Invalid element ID format found:\`, idOrIds);
               resolvedArgs[key] = null;
               continue;
            }
    
            if (selector) {
                const elementsNodeList = document.querySelectorAll(selector);
                if (isMultiple) {
                    resolvedArgs[key] = elementsNodeList;
                     if (elementsNodeList.length === 0) {
                        // console.warn(\`Dynamic Hydration (ID: \${blockId}, Task: \${taskIndex}, Key: \${key}): querySelectorAll found no elements for multi-element selector '\${selector}'.\`);
                     }
                } else {
                    resolvedArgs[key] = elementsNodeList[0] || null;
                    if (!resolvedArgs[key]) {
                        // console.warn(\`Dynamic Hydration (ID: \${blockId}, Task: \${taskIndex}, Key: \${key}): querySelectorAll found no element for single-element selector '\${selector}'.\`);
                    }
                }
            } else {
                 // Case where selector couldn't be built (e.g., invalid format noted above)
                 resolvedArgs[key] = isMultiple ? document.querySelectorAll(\`.non-existent-class-\${Date.now()}\`) : null;
            }
    
          } // End looping through elements
    
          // 4. Merge Static Data for this task instance
          const rawData = rawTask.data || {};
          for (const key in rawData) {
             if (resolvedArgs.hasOwnProperty(key)) {
                // console.warn(\`Dynamic Hydration (ID: \${blockId}, Task: \${taskIndex}, Key: \${key}): Data key clashes with element key. Data value will be used.\`);
             }
             resolvedArgs[key] = rawData[key];
          }
    
          // 5. Prepare for Code Execution
          const argNames = Object.keys(resolvedArgs);
          const argValues = argNames.map(name => resolvedArgs[name]);
    
          // 6. Execute the User's Hydration Code for this specific instance
          // console.log(\`Executing code for block ID: \${blockId}, task index: \${taskIndex} with args:\`, argNames); // Optional debug log
    
          const hydrateAction = new Function(...argNames, blockCodeString);
          hydrateAction(...argValues);
    
        } catch (error) {
          console.error(\`Error during dynamic hydration execution (ID: \${blockId}, Task Index: \${taskIndex}):\`, error, "Task details:", rawTask);
        }
      }); // End looping through raw tasks
    
      console.log("Dynamic hydration process finished (ID Only).");
    }
    
    
    // --- Initialization Logic (ID Only) ---
    function initializeDynamicHydrationById() {
        // Assumes window.__HYDRATOR_DATA__ (raw SSR data array) and
        // window.__BLOCK_DEFINITIONS__ (block definitions array, e.g., [{id: 0, code: '...'}])
        // are populated globally before this script runs.
        const rawData = window.__HYDRATOR_DATA__ || [];
        // Expects an array of objects like { id: ..., code: ... }
        const blockDefs = window.__BLOCK_DEFINITIONS__ || [];
    
        // Call the main hydration function
        hydrateDynamicallyById(rawData, blockDefs);
    }
    
    // Run after DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeDynamicHydrationById);
    } else {
      initializeDynamicHydrationById();
    }
    
    // -------- End Dynamic Hydration Runtime Code (ID Only) --------
    `);

  fs.writeFileSync(outputPath, beautify(hydrationCode.join('\n'), { indent_size: 2 }));
}


