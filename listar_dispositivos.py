"""
PASSO 2 - Listar dispositivos de audio disponiveis.
Rode este script para ver quais microfontes seu computador tem.
"""
import sounddevice as sd

print("=" * 60)
print("DISPOSITIVOS DE AUDIO DISPONIVEIS")
print("=" * 60)

dispositivos = sd.query_devices()

for i, dispositivo in enumerate(dispositivos):
    tipo = []
    if dispositivo["max_input_channels"] > 0:
        tipo.append("ENTRADA (microfone)")
    if dispositivo["max_output_channels"] > 0:
        tipo.append("SAIDA (caixas/fones)")

    if tipo:
        print(f"\n[{i}] {dispositivo['name']}")
        print(f"    Tipo: {' | '.join(tipo)}")
        print(f"    Canais de entrada: {dispositivo['max_input_channels']}")
        print(f"    Taxa padrao: {int(dispositivo['default_samplerate'])} Hz")

print("\n" + "=" * 60)
print("DISPOSITIVO PADRAO DO SISTEMA:")
print(f"  Entrada: {sd.query_devices(kind='input')['name']}")
print(f"  Saida:   {sd.query_devices(kind='output')['name']}")
print("=" * 60)
print("\nAnote o numero [X] do microfone que voce quer usar.")
