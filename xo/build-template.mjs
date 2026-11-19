// Writes treaty-escrow.template.json, the form of the template that the XO debug tool and Engine.importTemplate accept.
import { writeFileSync } from 'node:fs';
import { serializeTemplate } from '@xo-cash/utils';
import { treatyEscrowTemplate } from './treaty-escrow.template.mjs';

writeFileSync(new URL('./treaty-escrow.template.json', import.meta.url), serializeTemplate(treatyEscrowTemplate) + '\n');
console.log('treaty-escrow.template.json written');
