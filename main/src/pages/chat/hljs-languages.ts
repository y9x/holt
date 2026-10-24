// Discord's syntax-highlighting language set, registered on a highlight.js
// core instance. Loaded lazily (dynamic import from highlight.ts) so the
// ~170 grammars never weigh down the chat bundle - Discord also lazy-loads
// its highlighter chunk (818449/175134 → module 981776) and renders code
// blocks plain until it arrives.
//
// The set is every highlight.js grammar backing a name/alias in Discord's
// code-language list (web.js module 639169). Names from that list with no
// highlight.js core grammar (third-party grammars Discord bundles: alan,
// bbcode, blade, cypher, gdscript, solidity, svelte, terraform, …) render
// plain here. 'ansi' is Discord's own grammar, implemented in highlight.ts.
import hljs from 'highlight.js/lib/core'
import l_1c from 'highlight.js/lib/languages/1c'
import l_abnf from 'highlight.js/lib/languages/abnf'
import l_accesslog from 'highlight.js/lib/languages/accesslog'
import l_actionscript from 'highlight.js/lib/languages/actionscript'
import l_ada from 'highlight.js/lib/languages/ada'
import l_angelscript from 'highlight.js/lib/languages/angelscript'
import l_apache from 'highlight.js/lib/languages/apache'
import l_applescript from 'highlight.js/lib/languages/applescript'
import l_arcade from 'highlight.js/lib/languages/arcade'
import l_arduino from 'highlight.js/lib/languages/arduino'
import l_armasm from 'highlight.js/lib/languages/armasm'
import l_asciidoc from 'highlight.js/lib/languages/asciidoc'
import l_aspectj from 'highlight.js/lib/languages/aspectj'
import l_autohotkey from 'highlight.js/lib/languages/autohotkey'
import l_autoit from 'highlight.js/lib/languages/autoit'
import l_avrasm from 'highlight.js/lib/languages/avrasm'
import l_awk from 'highlight.js/lib/languages/awk'
import l_axapta from 'highlight.js/lib/languages/axapta'
import l_bash from 'highlight.js/lib/languages/bash'
import l_basic from 'highlight.js/lib/languages/basic'
import l_bnf from 'highlight.js/lib/languages/bnf'
import l_brainfuck from 'highlight.js/lib/languages/brainfuck'
import l_c from 'highlight.js/lib/languages/c'
import l_cal from 'highlight.js/lib/languages/cal'
import l_capnproto from 'highlight.js/lib/languages/capnproto'
import l_clojure from 'highlight.js/lib/languages/clojure'
import l_cmake from 'highlight.js/lib/languages/cmake'
import l_coffeescript from 'highlight.js/lib/languages/coffeescript'
import l_coq from 'highlight.js/lib/languages/coq'
import l_cos from 'highlight.js/lib/languages/cos'
import l_cpp from 'highlight.js/lib/languages/cpp'
import l_crmsh from 'highlight.js/lib/languages/crmsh'
import l_crystal from 'highlight.js/lib/languages/crystal'
import l_csharp from 'highlight.js/lib/languages/csharp'
import l_csp from 'highlight.js/lib/languages/csp'
import l_css from 'highlight.js/lib/languages/css'
import l_d from 'highlight.js/lib/languages/d'
import l_dart from 'highlight.js/lib/languages/dart'
import l_delphi from 'highlight.js/lib/languages/delphi'
import l_diff from 'highlight.js/lib/languages/diff'
import l_django from 'highlight.js/lib/languages/django'
import l_dns from 'highlight.js/lib/languages/dns'
import l_dockerfile from 'highlight.js/lib/languages/dockerfile'
import l_dos from 'highlight.js/lib/languages/dos'
import l_dsconfig from 'highlight.js/lib/languages/dsconfig'
import l_dts from 'highlight.js/lib/languages/dts'
import l_dust from 'highlight.js/lib/languages/dust'
import l_ebnf from 'highlight.js/lib/languages/ebnf'
import l_elixir from 'highlight.js/lib/languages/elixir'
import l_elm from 'highlight.js/lib/languages/elm'
import l_erlang from 'highlight.js/lib/languages/erlang'
import l_fix from 'highlight.js/lib/languages/fix'
import l_fortran from 'highlight.js/lib/languages/fortran'
import l_fsharp from 'highlight.js/lib/languages/fsharp'
import l_gams from 'highlight.js/lib/languages/gams'
import l_gauss from 'highlight.js/lib/languages/gauss'
import l_gcode from 'highlight.js/lib/languages/gcode'
import l_gherkin from 'highlight.js/lib/languages/gherkin'
import l_glsl from 'highlight.js/lib/languages/glsl'
import l_go from 'highlight.js/lib/languages/go'
import l_golo from 'highlight.js/lib/languages/golo'
import l_gradle from 'highlight.js/lib/languages/gradle'
import l_groovy from 'highlight.js/lib/languages/groovy'
import l_haml from 'highlight.js/lib/languages/haml'
import l_handlebars from 'highlight.js/lib/languages/handlebars'
import l_haskell from 'highlight.js/lib/languages/haskell'
import l_haxe from 'highlight.js/lib/languages/haxe'
import l_http from 'highlight.js/lib/languages/http'
import l_hy from 'highlight.js/lib/languages/hy'
import l_inform7 from 'highlight.js/lib/languages/inform7'
import l_ini from 'highlight.js/lib/languages/ini'
import l_irpf90 from 'highlight.js/lib/languages/irpf90'
import l_java from 'highlight.js/lib/languages/java'
import l_javascript from 'highlight.js/lib/languages/javascript'
import l_json from 'highlight.js/lib/languages/json'
import l_julia from 'highlight.js/lib/languages/julia'
import l_julia_repl from 'highlight.js/lib/languages/julia-repl'
import l_kotlin from 'highlight.js/lib/languages/kotlin'
import l_lasso from 'highlight.js/lib/languages/lasso'
import l_latex from 'highlight.js/lib/languages/latex'
import l_ldif from 'highlight.js/lib/languages/ldif'
import l_leaf from 'highlight.js/lib/languages/leaf'
import l_less from 'highlight.js/lib/languages/less'
import l_lisp from 'highlight.js/lib/languages/lisp'
import l_livecodeserver from 'highlight.js/lib/languages/livecodeserver'
import l_livescript from 'highlight.js/lib/languages/livescript'
import l_lua from 'highlight.js/lib/languages/lua'
import l_makefile from 'highlight.js/lib/languages/makefile'
import l_markdown from 'highlight.js/lib/languages/markdown'
import l_mathematica from 'highlight.js/lib/languages/mathematica'
import l_matlab from 'highlight.js/lib/languages/matlab'
import l_maxima from 'highlight.js/lib/languages/maxima'
import l_mel from 'highlight.js/lib/languages/mel'
import l_mercury from 'highlight.js/lib/languages/mercury'
import l_mizar from 'highlight.js/lib/languages/mizar'
import l_mojolicious from 'highlight.js/lib/languages/mojolicious'
import l_monkey from 'highlight.js/lib/languages/monkey'
import l_moonscript from 'highlight.js/lib/languages/moonscript'
import l_n1ql from 'highlight.js/lib/languages/n1ql'
import l_nginx from 'highlight.js/lib/languages/nginx'
import l_nim from 'highlight.js/lib/languages/nim'
import l_nix from 'highlight.js/lib/languages/nix'
import l_nsis from 'highlight.js/lib/languages/nsis'
import l_objectivec from 'highlight.js/lib/languages/objectivec'
import l_ocaml from 'highlight.js/lib/languages/ocaml'
import l_openscad from 'highlight.js/lib/languages/openscad'
import l_oxygene from 'highlight.js/lib/languages/oxygene'
import l_parser3 from 'highlight.js/lib/languages/parser3'
import l_perl from 'highlight.js/lib/languages/perl'
import l_pf from 'highlight.js/lib/languages/pf'
import l_pgsql from 'highlight.js/lib/languages/pgsql'
import l_php from 'highlight.js/lib/languages/php'
import l_plaintext from 'highlight.js/lib/languages/plaintext'
import l_pony from 'highlight.js/lib/languages/pony'
import l_powershell from 'highlight.js/lib/languages/powershell'
import l_processing from 'highlight.js/lib/languages/processing'
import l_profile from 'highlight.js/lib/languages/profile'
import l_prolog from 'highlight.js/lib/languages/prolog'
import l_properties from 'highlight.js/lib/languages/properties'
import l_protobuf from 'highlight.js/lib/languages/protobuf'
import l_puppet from 'highlight.js/lib/languages/puppet'
import l_python from 'highlight.js/lib/languages/python'
import l_python_repl from 'highlight.js/lib/languages/python-repl'
import l_q from 'highlight.js/lib/languages/q'
import l_qml from 'highlight.js/lib/languages/qml'
import l_r from 'highlight.js/lib/languages/r'
import l_reasonml from 'highlight.js/lib/languages/reasonml'
import l_rib from 'highlight.js/lib/languages/rib'
import l_roboconf from 'highlight.js/lib/languages/roboconf'
import l_rsl from 'highlight.js/lib/languages/rsl'
import l_ruby from 'highlight.js/lib/languages/ruby'
import l_ruleslanguage from 'highlight.js/lib/languages/ruleslanguage'
import l_rust from 'highlight.js/lib/languages/rust'
import l_sas from 'highlight.js/lib/languages/sas'
import l_scala from 'highlight.js/lib/languages/scala'
import l_scheme from 'highlight.js/lib/languages/scheme'
import l_scilab from 'highlight.js/lib/languages/scilab'
import l_scss from 'highlight.js/lib/languages/scss'
import l_shell from 'highlight.js/lib/languages/shell'
import l_smali from 'highlight.js/lib/languages/smali'
import l_smalltalk from 'highlight.js/lib/languages/smalltalk'
import l_sml from 'highlight.js/lib/languages/sml'
import l_sql from 'highlight.js/lib/languages/sql'
import l_stan from 'highlight.js/lib/languages/stan'
import l_stata from 'highlight.js/lib/languages/stata'
import l_step21 from 'highlight.js/lib/languages/step21'
import l_stylus from 'highlight.js/lib/languages/stylus'
import l_subunit from 'highlight.js/lib/languages/subunit'
import l_swift from 'highlight.js/lib/languages/swift'
import l_tap from 'highlight.js/lib/languages/tap'
import l_tcl from 'highlight.js/lib/languages/tcl'
import l_thrift from 'highlight.js/lib/languages/thrift'
import l_tp from 'highlight.js/lib/languages/tp'
import l_twig from 'highlight.js/lib/languages/twig'
import l_typescript from 'highlight.js/lib/languages/typescript'
import l_vala from 'highlight.js/lib/languages/vala'
import l_vbnet from 'highlight.js/lib/languages/vbnet'
import l_vbscript from 'highlight.js/lib/languages/vbscript'
import l_verilog from 'highlight.js/lib/languages/verilog'
import l_vhdl from 'highlight.js/lib/languages/vhdl'
import l_vim from 'highlight.js/lib/languages/vim'
import l_x86asm from 'highlight.js/lib/languages/x86asm'
import l_xl from 'highlight.js/lib/languages/xl'
import l_xml from 'highlight.js/lib/languages/xml'
import l_xquery from 'highlight.js/lib/languages/xquery'
import l_yaml from 'highlight.js/lib/languages/yaml'
import l_zephir from 'highlight.js/lib/languages/zephir'

const LANGUAGES: Record<string, typeof l_c> = {
  '1c': l_1c,
  'abnf': l_abnf,
  'accesslog': l_accesslog,
  'actionscript': l_actionscript,
  'ada': l_ada,
  'angelscript': l_angelscript,
  'apache': l_apache,
  'applescript': l_applescript,
  'arcade': l_arcade,
  'arduino': l_arduino,
  'armasm': l_armasm,
  'asciidoc': l_asciidoc,
  'aspectj': l_aspectj,
  'autohotkey': l_autohotkey,
  'autoit': l_autoit,
  'avrasm': l_avrasm,
  'awk': l_awk,
  'axapta': l_axapta,
  'bash': l_bash,
  'basic': l_basic,
  'bnf': l_bnf,
  'brainfuck': l_brainfuck,
  'c': l_c,
  'cal': l_cal,
  'capnproto': l_capnproto,
  'clojure': l_clojure,
  'cmake': l_cmake,
  'coffeescript': l_coffeescript,
  'coq': l_coq,
  'cos': l_cos,
  'cpp': l_cpp,
  'crmsh': l_crmsh,
  'crystal': l_crystal,
  'csharp': l_csharp,
  'csp': l_csp,
  'css': l_css,
  'd': l_d,
  'dart': l_dart,
  'delphi': l_delphi,
  'diff': l_diff,
  'django': l_django,
  'dns': l_dns,
  'dockerfile': l_dockerfile,
  'dos': l_dos,
  'dsconfig': l_dsconfig,
  'dts': l_dts,
  'dust': l_dust,
  'ebnf': l_ebnf,
  'elixir': l_elixir,
  'elm': l_elm,
  'erlang': l_erlang,
  'fix': l_fix,
  'fortran': l_fortran,
  'fsharp': l_fsharp,
  'gams': l_gams,
  'gauss': l_gauss,
  'gcode': l_gcode,
  'gherkin': l_gherkin,
  'glsl': l_glsl,
  'go': l_go,
  'golo': l_golo,
  'gradle': l_gradle,
  'groovy': l_groovy,
  'haml': l_haml,
  'handlebars': l_handlebars,
  'haskell': l_haskell,
  'haxe': l_haxe,
  'http': l_http,
  'hy': l_hy,
  'inform7': l_inform7,
  'ini': l_ini,
  'irpf90': l_irpf90,
  'java': l_java,
  'javascript': l_javascript,
  'json': l_json,
  'julia': l_julia,
  'julia-repl': l_julia_repl,
  'kotlin': l_kotlin,
  'lasso': l_lasso,
  'latex': l_latex,
  'ldif': l_ldif,
  'leaf': l_leaf,
  'less': l_less,
  'lisp': l_lisp,
  'livecodeserver': l_livecodeserver,
  'livescript': l_livescript,
  'lua': l_lua,
  'makefile': l_makefile,
  'markdown': l_markdown,
  'mathematica': l_mathematica,
  'matlab': l_matlab,
  'maxima': l_maxima,
  'mel': l_mel,
  'mercury': l_mercury,
  'mizar': l_mizar,
  'mojolicious': l_mojolicious,
  'monkey': l_monkey,
  'moonscript': l_moonscript,
  'n1ql': l_n1ql,
  'nginx': l_nginx,
  'nim': l_nim,
  'nix': l_nix,
  'nsis': l_nsis,
  'objectivec': l_objectivec,
  'ocaml': l_ocaml,
  'openscad': l_openscad,
  'oxygene': l_oxygene,
  'parser3': l_parser3,
  'perl': l_perl,
  'pf': l_pf,
  'pgsql': l_pgsql,
  'php': l_php,
  'plaintext': l_plaintext,
  'pony': l_pony,
  'powershell': l_powershell,
  'processing': l_processing,
  'profile': l_profile,
  'prolog': l_prolog,
  'properties': l_properties,
  'protobuf': l_protobuf,
  'puppet': l_puppet,
  'python': l_python,
  'python-repl': l_python_repl,
  'q': l_q,
  'qml': l_qml,
  'r': l_r,
  'reasonml': l_reasonml,
  'rib': l_rib,
  'roboconf': l_roboconf,
  'rsl': l_rsl,
  'ruby': l_ruby,
  'ruleslanguage': l_ruleslanguage,
  'rust': l_rust,
  'sas': l_sas,
  'scala': l_scala,
  'scheme': l_scheme,
  'scilab': l_scilab,
  'scss': l_scss,
  'shell': l_shell,
  'smali': l_smali,
  'smalltalk': l_smalltalk,
  'sml': l_sml,
  'sql': l_sql,
  'stan': l_stan,
  'stata': l_stata,
  'step21': l_step21,
  'stylus': l_stylus,
  'subunit': l_subunit,
  'swift': l_swift,
  'tap': l_tap,
  'tcl': l_tcl,
  'thrift': l_thrift,
  'tp': l_tp,
  'twig': l_twig,
  'typescript': l_typescript,
  'vala': l_vala,
  'vbnet': l_vbnet,
  'vbscript': l_vbscript,
  'verilog': l_verilog,
  'vhdl': l_vhdl,
  'vim': l_vim,
  'x86asm': l_x86asm,
  'xl': l_xl,
  'xml': l_xml,
  'xquery': l_xquery,
  'yaml': l_yaml,
  'zephir': l_zephir,
}

for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar)

export default hljs
