// core/kinds/index.js — importing this module registers every builtin kind. The import order (with each file's own
// imports) fixes the registration order, which is the palette order. Helpers come from the kind files themselves.
import './text.js';
import './dataset.js';
import './candidates.js';
import './execution.js';
import './evaluator.js';
import './deployment.js';
import './loop.js';
import './random.js';
import './params.js';
import './code.js';
import './partition.js';
import './scenario.js';
import './readout.js';
import './network.js';
import './trainer.js';
import './view.js';
import './script.js';
import './bits.js';
