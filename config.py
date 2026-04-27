"""
Gerencia configuracoes locais (chave da API) — evita depender de variaveis
de ambiente do sistema, o que pode ser dificil de configurar para usuarios comuns.
"""
import os
import json
from pathlib import Path


def _pasta_config() -> Path:
    """Pasta de configuracoes do usuario (AppData\\Local no Windows)."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        pasta = Path(base) / "GravadorDeReunioes"
    else:
        pasta = Path.home() / ".gravador-de-reunioes"
    pasta.mkdir(parents=True, exist_ok=True)
    return pasta


CONFIG_FILE = _pasta_config() / "config.json"


def carregar() -> dict:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def salvar(config: dict) -> None:
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def get_chave(nome: str) -> str:
    """Busca primeiro na variavel de ambiente, depois no config.json."""
    valor = os.environ.get(nome, "")
    if valor:
        return valor
    return carregar().get(nome.lower(), "")


def set_chave(nome: str, valor: str) -> None:
    """Salva no config.json e tambem no os.environ do processo atual."""
    cfg = carregar()
    cfg[nome.lower()] = valor
    salvar(cfg)
    os.environ[nome] = valor


def aplicar_no_ambiente() -> None:
    """Carrega chaves do config.json e coloca no os.environ."""
    cfg = carregar()
    for nome_lower, valor in cfg.items():
        if valor and not os.environ.get(nome_lower.upper()):
            os.environ[nome_lower.upper()] = valor
