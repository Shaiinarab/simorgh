module github.com/shaiinarab/simorgh/gateway

go 1.25

require (
	github.com/shaiinarab/simorgh/packages/config v0.0.0
	github.com/shaiinarab/simorgh/packages/crypto v0.0.0
	github.com/shaiinarab/simorgh/packages/ledger v0.0.0
	github.com/shaiinarab/simorgh/packages/providers v0.0.0
	github.com/shaiinarab/simorgh/packages/providers/groq v0.0.0
	gopkg.in/yaml.v3 v3.0.1
)

replace github.com/shaiinarab/simorgh/packages/config => ../packages/config

replace github.com/shaiinarab/simorgh/packages/crypto => ../packages/crypto

replace github.com/shaiinarab/simorgh/packages/ledger => ../packages/ledger

replace github.com/shaiinarab/simorgh/packages/providers => ../packages/providers

replace github.com/shaiinarab/simorgh/packages/providers/groq => ../packages/providers/groq
