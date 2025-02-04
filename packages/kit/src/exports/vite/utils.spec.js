import path from 'path';
import { test } from 'uvu';
import * as assert from 'uvu/assert';
import { validate_config } from '../../core/config/index.js';
import { posixify } from '../../utils/filesystem.js';
import {
	deep_merge,
	get_aliases,
	merge_vite_configs,
	prevent_illegal_rollup_imports,
	prevent_illegal_vite_imports
} from './utils.js';

const illegal_id = '/@id/__x00__$env/dynamic/private';

test('basic test no conflicts', async () => {
	const merged = deep_merge(
		{
			version: 1,
			animalSounds: {
				cow: 'moo'
			}
		},
		{
			animalSounds: {
				duck: 'quack'
			},
			locale: 'en_US'
		}
	);

	assert.equal(merged, {
		version: 1,
		locale: 'en_US',
		animalSounds: {
			cow: 'moo',
			duck: 'quack'
		}
	});
});

test('three way merge no conflicts', async () => {
	const merged = deep_merge(
		{
			animalSounds: {
				cow: 'moo'
			}
		},
		{
			animalSounds: {
				duck: 'quack'
			}
		},
		{
			animalSounds: {
				dog: {
					singular: 'bark',
					plural: 'barks'
				}
			}
		}
	);
	assert.equal(merged, {
		animalSounds: {
			cow: 'moo',
			duck: 'quack',
			dog: {
				singular: 'bark',
				plural: 'barks'
			}
		}
	});
});

test('merge with conflicts', async () => {
	const merged = deep_merge(
		{
			person: {
				firstName: 'John',
				lastName: 'Doe',
				address: {
					line1: '123 Main St',
					city: 'Seattle',
					state: 'WA'
				}
			}
		},
		{
			person: {
				middleInitial: 'Q',
				address: '123 Main St, Seattle, WA'
			}
		}
	);
	assert.equal(merged, {
		person: {
			firstName: 'John',
			middleInitial: 'Q',
			lastName: 'Doe',
			address: '123 Main St, Seattle, WA'
		}
	});
});

test('merge with arrays', async () => {
	const merged = deep_merge(
		{
			paths: ['/foo', '/bar']
		},
		{
			paths: ['/alpha', '/beta']
		}
	);
	assert.equal(merged, {
		paths: ['/foo', '/bar', '/alpha', '/beta']
	});
});

test('empty', async () => {
	const merged = deep_merge();
	assert.equal(merged, {});
});

test('mutability safety', () => {
	const input1 = {
		person: {
			firstName: 'John',
			lastName: 'Doe',
			address: {
				line1: '123 Main St',
				city: 'Seattle'
			}
		}
	};
	const input2 = {
		person: {
			middleInitial: 'L',
			lastName: 'Smith',
			address: {
				state: 'WA'
			}
		}
	};
	const snapshot1 = JSON.stringify(input1);
	const snapshot2 = JSON.stringify(input2);

	const merged = deep_merge(input1, input2);

	// Mess with the result
	merged.person.middleInitial = 'Z';
	merged.person.address.zipCode = '98103';
	merged.person = {};

	// Make sure nothing in the inputs changed
	assert.snapshot(snapshot1, JSON.stringify(input1));
	assert.snapshot(snapshot2, JSON.stringify(input2));
});

test('merge buffer', () => {
	const merged = deep_merge(
		{
			x: Buffer.from('foo', 'utf-8')
		},
		{
			y: 12345
		}
	);
	assert.equal(Object.keys(merged), ['x', 'y']);
});

test('merge including toString', () => {
	const merged = deep_merge(
		{
			toString: () => '',
			constructor: () => ''
		},
		{
			y: 12345
		}
	);
	assert.equal(Object.keys(merged), ['toString', 'constructor', 'y']);
});

test('merge resolve.alias', () => {
	const merged = merge_vite_configs(
		{
			resolve: {
				alias: [{ find: /foo/, replacement: 'bar' }]
			}
		},
		{
			resolve: {
				alias: {
					alpha: 'beta'
				}
			}
		}
	);
	assert.equal(merged, {
		resolve: {
			alias: [
				{ find: /foo/, replacement: 'bar' },
				{ find: 'alpha', replacement: 'beta' }
			]
		}
	});
});

test('transform kit.alias to resolve.alias', () => {
	const config = validate_config({
		kit: {
			alias: {
				simpleKey: 'simple/value',
				key: 'value',
				'key/*': 'value/*',
				$regexChar: 'windows\\path',
				'$regexChar/*': 'windows\\path\\*'
			}
		}
	});

	const transformed = get_aliases(config.kit).map((entry) => {
		const replacement = posixify(path.relative('.', entry.replacement));

		return {
			find: entry.find.toString(), // else assertion fails
			replacement
		};
	});

	assert.equal(transformed, [
		{ find: '__GENERATED__', replacement: '.svelte-kit/generated' },
		{ find: '$app', replacement: 'src/runtime/app' },
		{ find: '$lib', replacement: 'src/lib' },
		{ find: 'simpleKey', replacement: 'simple/value' },
		{ find: /^key$/.toString(), replacement: 'value' },
		{ find: /^key\/(.+)$/.toString(), replacement: 'value/$1' },
		{ find: /^\$regexChar$/.toString(), replacement: 'windows/path' },
		{ find: /^\$regexChar\/(.+)$/.toString(), replacement: 'windows/path/$1' }
	]);
});

/** @typedef {{id: string, importedIds: Array<string>, dynamicallyImportedIds: Array<string> }} RollupNode */

/** @type {(id: string) => RollupNode | null} */
const rollup_node_getter = (id) => {
	/** @type {{[key: string]: RollupNode}} */
	const nodes = {
		'/test/path1.js': {
			id: '/test/path1.js',
			importedIds: ['/test/path2.js', '/test/path3.js'],
			dynamicallyImportedIds: ['/test/path4.js', '/test/path5.js']
		},
		'/test/path2.js': {
			id: '/test/path2.js',
			importedIds: ['/test/path3.js'],
			dynamicallyImportedIds: ['/test/path5.js']
		},
		'/test/path3.js': {
			id: '/test/path3.js',
			importedIds: ['/test/path5.js'],
			dynamicallyImportedIds: ['/test/path1.js']
		},
		'/test/path4.js': {
			id: '/test/path4.js',
			importedIds: ['/test/path5.js'],
			dynamicallyImportedIds: ['/test/path3.js']
		},
		'/test/path5.js': {
			id: '/test/path5.js',
			importedIds: ['/test/path1.js'],
			dynamicallyImportedIds: ['/test/path3.js']
		},
		'/bad/static.js': {
			id: '/bad/static.js',
			importedIds: ['/statically-imports/bad/module.js'],
			dynamicallyImportedIds: ['/test/path1.js']
		},
		'/statically-imports/bad/module.js': {
			id: '/statically-imports/bad/module.js',
			importedIds: [illegal_id],
			dynamicallyImportedIds: ['/test/path2.js']
		},
		'/bad/dynamic.js': {
			id: '/bad/dynamic.js',
			importedIds: ['/dynamically-imports/bad/module.js'],
			dynamicallyImportedIds: ['/test/path1.js']
		},
		'/dynamically-imports/bad/module.js': {
			id: '/dynamically-imports/bad/module.js',
			importedIds: ['/test/path5.js'],
			dynamicallyImportedIds: ['/test/path2.js', illegal_id]
		},
		[illegal_id]: {
			id: illegal_id,
			importedIds: [],
			dynamicallyImportedIds: []
		}
	};
	return nodes[id] ?? null;
};

const ok_rollup_node = rollup_node_getter('/test/path1.js');
const bad_rollup_node_static = rollup_node_getter('/bad/static.js');
const bad_rollup_node_dynamic = rollup_node_getter('/bad/dynamic.js');

test('allows ok rollup imports', () => {
	assert.not.throws(() => {
		prevent_illegal_rollup_imports(
			// @ts-expect-error
			rollup_node_getter,
			ok_rollup_node,
			'should_not_match_anything'
		);
	});
});

test('does not allow bad static rollup imports', () => {
	assert.throws(() => {
		prevent_illegal_rollup_imports(
			// @ts-expect-error
			rollup_node_getter,
			bad_rollup_node_static,
			'should_not_match_anything'
		);
	});
});

test('does not allow bad dynamic rollup imports', () => {
	assert.throws(() => {
		prevent_illegal_rollup_imports(
			// @ts-expect-error
			rollup_node_getter,
			bad_rollup_node_dynamic,
			'should_not_match_anything'
		);
	});
});

/** @typedef {{id: string, importedModules: Set<ViteNode>}} ViteNode */

/** @type {ViteNode} */
const ok_vite_node = {
	id: '/test/ok.js',
	importedModules: new Set([
		{
			id: '/test/path1.js',
			importedModules: new Set([
				{
					id: '/test/path2.js',
					importedModules: new Set()
				}
			])
		},
		{ id: '/test/path3.js', importedModules: new Set() }
	])
};

/** @type {ViteNode} */
const bad_vite_node = {
	id: '/test/bad-static.js',
	importedModules: new Set([
		{
			id: '/test/path1.js',
			importedModules: new Set([
				{
					id: '/test/path2.js',
					importedModules: new Set([
						{
							id: illegal_id,
							importedModules: new Set()
						}
					])
				}
			])
		},
		{ id: '/test/path3.js', importedModules: new Set() }
	])
};

test('allows ok vite imports', () => {
	assert.not.throws(() => {
		prevent_illegal_vite_imports(
			// @ts-expect-error
			ok_vite_node,
			'should_not_match_anything',
			[]
		);
	});
});

test('does not allow bad static rollup imports', () => {
	assert.throws(() => {
		prevent_illegal_vite_imports(
			// @ts-expect-error
			bad_vite_node,
			'should_not_match_anything',
			[]
		);
	});
});

test.run();
