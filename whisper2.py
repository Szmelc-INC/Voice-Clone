#!/usr/bin/env python3
import os
import sys
import argparse
import warnings
import torch

# Hard override GFX dla RDNA 4 przed jakimkolwiek importem C++
os.environ["HSA_OVERRIDE_GFX_VERSION"] = "12.0.0"

def parse_args():
    p = argparse.ArgumentParser(description="Whisper STT - GPU Accelerated")
    p.add_argument("input", help="Ścieżka do pliku audio/wideo")
    p.add_argument("-o", "--output", help="Zapis do pliku wyjściowego (np. transkrypcja.txt)")
    p.add_argument("-l", "--language", default="polish", help="Język transkrypcji (domyślnie: polish)")
    p.add_argument("-b", "--batch-size", type=int, default=4, help="Rozmiar batcha. 4-8 nie zamula DE, 16 max speed (def: 4)")
    p.add_argument("--debug", action="store_true", help="Wypluwa logi, info o GPU i timestampy")
    return p.parse_args()

def main():
    args = parse_args()

    # Tłumienie logów jeśli brak flagi --debug
    if not args.debug:
        os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
        warnings.filterwarnings("ignore")
        import logging
        logging.getLogger("transformers").setLevel(logging.ERROR)

    try:
        from rich.console import Console
        from rich.progress import Progress, SpinnerColumn, TextColumn
        console = Console()
    except ImportError:
        print("Brak modułu rich. Odpal: pip install rich")
        sys.exit(1)

    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

    # Ograniczenie wątków CPU dla preprocessingu, żeby nie zarzynać systemu
    torch.set_num_threads(4)

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    torch_dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    model_id = "openai/whisper-large-v3-turbo"

    if args.debug:
        console.rule("[bold cyan]DEBUG INFO")
        console.print(f"Urządzenie : [bold]{device}[/bold] ({torch.cuda.get_device_name(0) if device == 'cuda:0' else 'Brak ROCm'})")
        console.print(f"Batch size : [bold]{args.batch_size}[/bold]")
        console.print(f"CPU Threads: [bold]{torch.get_num_threads()}[/bold]")
        console.print(f"Target Lang: [bold]{args.language}[/bold]\n")

    # Blok z paskiem postępu (spinner) ukrywa loading i processing
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        transient=True, # Znika po zakończeniu
        console=console
    ) as progress:
        
        task = progress.add_task(f"[yellow]Ładowanie {model_id} do VRAM...", total=None)
        
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_id, 
            torch_dtype=torch_dtype, 
            low_cpu_mem_usage=True, 
            use_safetensors=True
        ).to(device)
        
        processor = AutoProcessor.from_pretrained(model_id)
        
        pipe = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            torch_dtype=torch_dtype,
            device=device,
        )
        
        progress.update(task, description=f"[green]Przetwarzanie {args.input} (GPU w stresie)...")
        
        # Transkrypcja (chunk_length_s dzieli długie nagrania by nie wywalić OOM)
        result = pipe(
            args.input, 
            generate_kwargs={"language": args.language, "task": "transcribe"},
            return_timestamps=True,
            chunk_length_s=30,
            batch_size=args.batch_size
        )

    # Wyrzucenie tekstu (albo na ekran, albo do pliku)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(result["text"].strip() + "\n")
            if args.debug:
                f.write("\n--- TIMESTAMPY ---\n")
                for chunk in result.get("chunks", []):
                    ts = chunk["timestamp"]
                    f.write(f"[{ts[0]:.2f}s -> {ts[1]:.2f}s] {chunk['text']}\n")
        
        console.print(f"[bold green]✔[/bold green] Transkrypcja zapisana do: [bold]{args.output}[/bold]")
    else:
        # Standardowy pretty print na konsolę
        console.print(result["text"].strip())
        
        if args.debug:
            console.rule("[bold blue]TIMESTAMPY")
            for chunk in result.get("chunks", []):
                ts = chunk["timestamp"]
                console.print(f"[[cyan]{ts[0]:.2f}s[/cyan] -> [cyan]{ts[1]:.2f}s[/cyan]] {chunk['text']}")

if __name__ == "__main__":
    main()
