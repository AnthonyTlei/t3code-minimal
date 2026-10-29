.DEFAULT_GOAL := help
PYTHON ?= python3
export ROOT
export CODEX
export PORT
export NO_BUILD
NO_BUILD_FLAG := $(if $(filter 1,$(NO_BUILD)),--no-build,)

.PHONY: help configure build up on down off stop restart logs status health open doctor test test-e2e package

help: ## Show commands
	@$(PYTHON) -c 'import re; text=open("Makefile").read(); print("T3 Code Local\n\n  make configure ROOT=/absolute/workspace CODEX=/approved/codex\n  make up && make open\n"); [print("  {:<13} {}".format(*m)) for m in re.findall(r"^([\w-]+):.*?## (.+)$$", text, re.M)]'

configure: ## Save explicit roots and existing CLI path; does not read credentials
	@$(PYTHON) scripts/manage.py configure

build: ## Build the local application image
	@$(PYTHON) scripts/manage.py build

up: ## Build/start the container and loopback host bridge; preserve local data
	@$(PYTHON) scripts/manage.py up $(NO_BUILD_FLAG)

on: up ## Alias for up

down: ## Stop the owned bridge and container; preserve local history
	@$(PYTHON) scripts/manage.py down

off: down ## Alias for down

stop: down ## Alias for down

restart: ## Restart the complete local stack, keeping state
	@$(PYTHON) scripts/manage.py restart $(NO_BUILD_FLAG)

logs: ## Show recent host bridge logs and follow container logs (Ctrl-C detaches)
	@$(PYTHON) scripts/manage.py logs

status: ## Show bridge, application and container state
	@$(PYTHON) scripts/manage.py status

health: ## Check loopback HTTP and CLI transport readiness without a model call
	@$(PYTHON) scripts/manage.py health

open: ## Open the private local browser session without printing its token
	@$(PYTHON) scripts/manage.py open

doctor: ## Read-only local tool/context/configuration checks
	@$(PYTHON) scripts/manage.py doctor

test: ## Run focused application and packaging tests
	npm test
	@$(PYTHON) -m unittest discover -s minimal/test -p 'manage_test.py'

test-e2e: ## Run the real-browser synthetic end-to-end suite
	npm run test:e2e

package: ## Build the web bundle and create the allowlisted release archive
	npm run build
	npm run package
	npm run verify:release
