// build/extract-all.js
import fs from 'fs';
import path from 'path';
import { extractHandlers } from './extract-new-utils.js';
import config from './components.config.js';

async function extractAllComponents() {
  const outputDir = './dist/';
  
  // Process each component
  await Promise.all(Object.entries(config).map(async ([name, cfg]) => {
    const outputPath = path.join(outputDir, `${name}-hydrate.js`);
    await extractHandlers(outputPath, cfg);
  }));

  // Generate unified loader
  const loaderCode = Object.keys(config).map(name => 
    `import './${name}-hydrate.js';`
  ).join('\n');
  
  fs.writeFileSync(path.join(outputDir, 'loader.js'), loaderCode);
}

// Run extraction
extractAllComponents();
